#!/usr/bin/env node
// Generation service for the hosted site. Runs on a machine with Chrome + FFmpeg
// (the Mac mini), reached only through a tunnel from the Cloudflare Worker.
//
//   POST /generate {url}      server-sent events: status, product, token, result, video | error
//   GET  /video/<id>.mp4      the rendered file for a finished job
//   GET  /health
//
// Every request must carry x-backend-key matching BACKEND_KEY. The Worker owns
// login and per-user limits; this service owns the model key and the rendering.
import http from "node:http";
import { mkdir, writeFile, readFile, rename, stat, cp } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrape, download } from "./scrape.mjs";
import { thumbnail } from "./thumb.mjs";
import { writeBrief } from "./brief.mjs";
import { MODEL, briefRequest, parse } from "./core/brief-core.mjs";
import { composeVideo, VERSION_STYLES, STYLE_LABELS, SOUND_CUES } from "./styles.mjs";
import { soundtrack } from "./audio.mjs";
import { cutout } from "./cutout.mjs";
import { SYSTEM_DIRECTOR, normalizeStoryboard, composeDirected, storyboardCues } from "./director.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOBS = path.join(ROOT, "jobs");
const PORT = Number(process.env.PORT ?? 8787);
const BACKEND_KEY = process.env.BACKEND_KEY ?? "";
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY ?? "";
const VIA = process.env.BRIEF_VIA ?? "cerebras"; // "openclaw" runs the brief as an OpenClaw agent turn
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE ?? 4);
const RENDER_JOBS = Number(process.env.RENDER_JOBS ?? 2);
if (!BACKEND_KEY || BACKEND_KEY.length < 24) throw new Error("Set BACKEND_KEY (24+ characters)");
if (!CEREBRAS_KEY) throw new Error("Set CEREBRAS_API_KEY");

const authed = (req) => {
  const got = Buffer.from(String(req.headers["x-backend-key"] ?? ""));
  const want = Buffer.from(BACKEND_KEY);
  return got.length === want.length && timingSafeEqual(got, want);
};
const sized = (src, width) => {
  try {
    const u = new URL(src);
    if (/(^|\.)shopify\.com$/.test(u.hostname) || u.pathname.includes("/cdn/shop/")) u.searchParams.set("width", String(width));
    return u.href;
  } catch {
    return src;
  }
};

// Render pool: a couple of renders may overlap; more starve each other.
let rendering = 0;
const renderQueue = [];
async function render(dir) {
  if (rendering >= RENDER_JOBS) await new Promise((r) => renderQueue.push(r));
  rendering++;
  try {
    const once = () => run(path.join(ROOT, "node_modules/.bin/hyperframes"), ["render", "--output", "video.mp4", "--quiet"], { cwd: dir, maxBuffer: 1 << 26, env: { ...process.env, HYPERFRAMES_RENDER_LOCK: "off" } });
    // A cold font fetch can stall the first page load; the second attempt hits the cache.
    await once().catch(() => once());
  } finally {
    rendering--;
    renderQueue.shift()?.();
  }
}


// Kimi on Cerebras, streamed so the visitor watches the brief being written.
async function streamBrief(product, imageData, send) {
  const t0 = Date.now();
  // Cerebras sheds load with 429s when busy. Wait and try again a few times before giving up.
  const body = JSON.stringify(briefRequest(product, { imageData, stream: true, system: SYSTEM_DIRECTOR }));
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${CEREBRAS_KEY}`, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(240000),
    });
    if (res.status !== 429 || attempt >= 9) break;
    await res.body?.cancel();
    send("status", { stage: "queued", note: `Cerebras is busy, retrying (${attempt + 1})` });
    await new Promise((r) => setTimeout(r, Math.min(3000 + attempt * 2000, 12000)));
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error("Kimi K3.1 Pro access for this demo has ended (it was a hackathon preview).");
    if (res.status === 429) throw new Error("Kimi is overloaded right now. Please try again in a minute.");
    throw new Error(`Kimi returned ${res.status}${err?.message ? ": " + String(err.message).slice(0, 120) : ""}`);
  }
  const dec = new TextDecoder();
  let buffer = "";
  let content = "";
  let firstAt = null;
  let usage = null;
  let timeInfo = null;
  for await (const chunk of res.body) {
    buffer += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(payload);
      } catch {
        continue;
      }
      const d = j.choices?.[0]?.delta ?? {};
      if (firstAt == null && (d.content || d.reasoning)) {
        firstAt = Date.now();
        send("status", { stage: "writing" });
      }
      if (d.content) {
        content += d.content;
        send("token", { text: d.content });
      }
      if (j.usage) usage = j.usage;
      if (j.time_info) timeInfo = j.time_info;
    }
  }
  const completion = timeInfo?.completion_time ?? (firstAt ? (Date.now() - firstAt) / 1000 : null);
  return {
    raw: parse(content),
    stats: {
      model: MODEL,
      via: "cerebras",
      vision: imageData.length > 0,
      wallSeconds: +((Date.now() - t0) / 1000).toFixed(2),
      queueSeconds: timeInfo?.queue_time != null ? +timeInfo.queue_time.toFixed(2) : firstAt ? +((firstAt - t0) / 1000).toFixed(2) : null,
      writeSeconds: completion != null ? +completion.toFixed(2) : null,
      tokens: usage?.completion_tokens ?? null,
      tps: usage?.completion_tokens && completion ? Math.round(usage.completion_tokens / completion) : null,
    },
  };
}

// Platform exports. The three vertical platforms take the same picture; what
// differs is the encode each one recommends. Other shapes keep the whole
// vertical video and fill the sides with a blurred copy of itself.
const V = "-c:v libx264 -profile:v high -pix_fmt yuv420p -r 30 -movflags +faststart -c:a aac -ar 48000 -ac 2";
const blurFill = (w, h) => `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=28:2,eq=brightness=-0.12[bg];[0:v]scale=-2:${h}[fg];[bg][fg]overlay=(W-w)/2:0`;
export const FORMATS = {
  shorts: { label: "YouTube Shorts", args: `-vf scale=1080:1920 ${V} -b:v 10M -maxrate 12M -bufsize 20M -b:a 192k` },
  reels: { label: "Instagram Reels", args: `-vf scale=1080:1920 ${V} -b:v 6M -maxrate 8M -bufsize 12M -b:a 128k` },
  tiktok: { label: "TikTok", args: `-vf scale=1080:1920 ${V} -b:v 8M -maxrate 10M -bufsize 16M -b:a 128k` },
  square: { label: "Square 1:1", args: `-filter_complex ${blurFill(1080, 1080)} ${V} -b:v 6M -b:a 128k` },
  feed: { label: "Feed 4:5", args: `-filter_complex ${blurFill(1080, 1350)} ${V} -b:v 6M -b:a 128k` },
  landscape: { label: "Landscape 16:9", args: `-filter_complex ${blurFill(1920, 1080)} ${V} -b:v 10M -b:a 192k` },
};
const exporting = new Map();
// Exports are real encodes, so they queue: at most two at once, each with a time limit.
const EXPORT_SLOTS = 2;
let exportsRunning = 0;
const exportWaiters = [];
async function exportFormat(source, format) {
  await stat(source);
  const out = path.join(path.dirname(source), `${format}.mp4`);
  if (await stat(out).then(() => true, () => false)) return out;
  // One encode per file, however many requests ask for it.
  if (!exporting.has(out)) {
    const tmp = `${out}.part.mp4`;
    const job = (async () => {
      if (exportsRunning >= EXPORT_SLOTS) await new Promise((r) => exportWaiters.push(r));
      exportsRunning++;
      try {
        await run("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", source, ...FORMATS[format].args.split(" "), tmp], { maxBuffer: 1 << 24, timeout: 90000, killSignal: "SIGKILL" });
        await rename(tmp, out);
      } finally {
        exportsRunning--;
        exportWaiters.shift()?.();
      }
    })();
    exporting.set(out, job.finally(() => exporting.delete(out)));
  }
  await exporting.get(out);
  return out;
}

let active = 0;

async function generate(url, send, assetBase) {
  const id = randomUUID();
  const dir = path.join(JOBS, id);
  await mkdir(path.join(dir, "assets"), { recursive: true });

  const t0 = Date.now();
  send("status", { stage: "scraping" });
  const product = await scrape(url);
  const scrapeSeconds = +((Date.now() - t0) / 1000).toFixed(2);
  send("product", { brand: product.brand, title: product.title, price: product.price, compareAt: product.compareAt, domain: product.domain, url: product.url, imageCount: product.images.length, thumb: sized(product.images[0], 320) });
  send("status", { stage: "queued" });

  // All images download in parallel; the brief starts once the first four are in.
  const sources = product.images;
  const downloads = sources.map(async (src, i) => {
    try {
      const tmp = path.join(dir, "assets", `img${i}`);
      const kind = await download(src, tmp);
      const rel = `assets/img${i}.${kind}`;
      await rename(tmp, path.join(dir, rel));
      return { src, rel, kind };
    } catch {
      return null;
    }
  });
  const briefJob = (async () => {
    if (VIA === "openclaw") {
      const r = await writeBrief(product, { via: "openclaw" });
      send("status", { stage: "writing" });
      return { briefs: VERSION_STYLES.map(() => r.brief), stats: { model: r.stats.model, via: "openclaw", vision: false, wallSeconds: r.stats.wallSeconds, queueSeconds: null, writeSeconds: null, tokens: r.stats.completionTokens ?? null, tps: null } };
    }
    const usable = [];
    for (const h of await Promise.all(downloads.slice(0, 4))) {
      if (!h) break;
      usable.push(h);
    }
    const thumbs = [];
    for (const data of await Promise.all(usable.map((h) => thumbnail(path.join(dir, h.rel), h.kind)))) {
      if (!data) break; // keep indices aligned with what the model is shown
      thumbs.push(data);
    }
    return streamBrief(product, thumbs, send);
  })();
  const [all, { briefs: legacy, raw, stats }] = await Promise.all([Promise.all(downloads), briefJob]);

  const keptIdx = all.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
  if (!keptIdx.length) throw new Error("Couldn't download that product's photos.");
  const remap = (i) => Math.max(0, keptIdx.indexOf(i));
  product.images = keptIdx.map((i) => sources[i]);
  const local = keptIdx.map((i) => all[i].rel);
  const remote = product.images.map((s) => sized(s, 1080));

  // Lift products off plain studio backgrounds. One cutout per kept photo, or null.
  const cuts = await Promise.all(
    keptIdx.slice(0, 5).map(async (srcIdx, i) => {
      try {
        const name = `cut${i}.png`;
        return (await cutout(path.join(dir, all[srcIdx].rel), all[srcIdx].kind, path.join(dir, "assets", name))) ? name : null;
      } catch {
        return null;
      }
    }),
  );
  const cutLocal = cuts.map((n) => (n ? `assets/${n}` : null));
  // The browser version loads cutouts through the site; without that it uses the plain photos.
  const cutRemote = cuts.map((n) => (n && assetBase ? `${assetBase}/${id}/${n}` : null));

  // Three versions. Normally each is a storyboard the model directed; the OpenClaw
  // path still returns a plain brief, which the older fixed styles stage.
  const pool = Array.isArray(raw?.variants) && raw.variants.length ? raw.variants : raw ? [raw] : [];
  const versions = VERSION_STYLES.map((fallbackStyle, n) => {
    if (legacy) {
      const b = legacy[n];
      const brief = { ...b, heroImage: remap(b.heroImage), featureImages: b.featureImages.map(remap) };
      return { n, style: fallbackStyle, label: STYLE_LABELS[fallbackStyle], brief, theme: brief.theme, cues: SOUND_CUES[fallbackStyle], compose: (imgs, o) => composeVideo(product, brief, imgs, { style: fallbackStyle, ...o }) };
    }
    const sb = normalizeStoryboard(pool[n % Math.max(1, pool.length)], product);
    return { n, style: "director", label: sb.concept || `Concept ${n + 1}`, brief: { hook: sb.scenes.map((x) => x.type).join(" → "), theme: sb.theme }, theme: sb.theme, cues: storyboardCues(sb), compose: (imgs, o) => composeDirected(product, sb, imgs, o) };
  });
  const publicVersion = (v) => ({ n: v.n, style: v.style, label: v.label, brief: { hook: v.brief.hook, theme: v.brief.theme } });

  // Kept with the job so it can be listed later under the account that made it.
  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({
      id,
      createdAt: new Date().toISOString(),
      product: { brand: product.brand, title: product.title, price: product.price, domain: product.domain, url: product.url, thumb: sized(product.images[0], 320) },
      versions: versions.map((v) => ({ n: v.n, style: v.style, label: v.label, hook: v.brief.hook, theme: v.brief.theme })),
    }),
  );
  send("result", { id, stats: { ...stats, scrapeSeconds }, versions: versions.map((v) => ({ ...publicVersion(v), html: v.compose(remote, { web: true, cutouts: cutRemote }) })) });

  // Then the MP4s, through the render pool.
  send("status", { stage: "rendering" });
  await Promise.all(
    versions.map(async (v) => {
      const vdir = path.join(dir, `v${v.n}`);
      await mkdir(vdir, { recursive: true });
      await Promise.all([
        cp(path.join(dir, "assets"), path.join(vdir, "assets"), { recursive: true }),
        writeFile(path.join(vdir, "music.wav"), soundtrack({ theme: v.theme, ...v.cues })),
        writeFile(path.join(vdir, "index.html"), v.compose(local, { audio: "music.wav", cutouts: cutLocal })),
        writeFile(path.join(vdir, "hyperframes.json"), JSON.stringify({ paths: { assets: "assets" } })),
      ]);
      const tR = Date.now();
      try {
        await render(vdir);
        send("video", { id, n: v.n, renderSeconds: +((Date.now() - tR) / 1000).toFixed(1) });
      } catch (e) {
        console.error(new Date().toISOString(), `render v${v.n} failed:`, String(e?.message ?? e).slice(0, 200));
        send("video", { id, n: v.n, failed: true });
      }
    }),
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, active, rendering }));
  if (!authed(req)) return res.writeHead(401).end("unauthorized");

  const a = /^\/asset\/([0-9a-f-]{36})\/(cut[0-9]\.png)$/.exec(url.pathname);
  if (a && req.method === "GET") {
    const file = path.join(JOBS, a[1], "assets", a[2]);
    try {
      const size = (await stat(file)).size;
      res.writeHead(200, { "content-type": "image/png", "content-length": size, "cache-control": "public, max-age=86400" });
      return createReadStream(file).pipe(res);
    } catch {
      return res.writeHead(404).end("not found");
    }
  }

  const j = /^\/job\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (j && req.method === "GET") {
    try {
      const meta = JSON.parse(await readFile(path.join(JOBS, j[1], "meta.json"), "utf8"));
      // A version is ready once its MP4 exists.
      meta.versions = await Promise.all(meta.versions.map(async (v) => ({ ...v, ready: await stat(path.join(JOBS, j[1], `v${v.n}`, "video.mp4")).then(() => true, () => false) })));
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(meta));
    } catch {
      return res.writeHead(404).end("not found");
    }
  }

  const m = /^\/video\/([0-9a-f-]{36})-([0-9])\.mp4$/.exec(url.pathname);
  if (m && (req.method === "GET" || req.method === "HEAD")) {
    let file = path.join(JOBS, m[1], `v${m[2]}`, "video.mp4");
    const format = url.searchParams.get("format");
    if (format) {
      if (!Object.hasOwn(FORMATS, format)) return res.writeHead(400).end("unknown format");
      try {
        file = await exportFormat(file, format);
      } catch {
        return res.writeHead(404).end("not found");
      }
    }
    let size;
    try {
      size = (await stat(file)).size;
    } catch {
      return res.writeHead(404).end("not found");
    }
    // Byte ranges, so the file plays and seeks in every browser.
    const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (r && (r[1] !== "" || r[2] !== "")) {
      const start = r[1] === "" ? Math.max(size - Number(r[2]), 0) : Number(r[1]);
      const end = r[1] === "" || r[2] === "" ? size - 1 : Math.min(Number(r[2]), size - 1);
      if (start >= size || start > end) return res.writeHead(416, { "content-range": `bytes */${size}` }).end();
      res.writeHead(206, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      return req.method === "HEAD" ? res.end() : createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": size });
    return req.method === "HEAD" ? res.end() : createReadStream(file).pipe(res);
  }

  if (url.pathname === "/generate" && req.method === "POST") {
    let body = "";
    for await (const c of req) {
      body += c;
      if (body.length > 4000) return res.writeHead(413).end();
    }
    let target;
    let assetBase = null;
    try {
      const parsed = JSON.parse(body);
      target = new URL(parsed.url);
      if (target.protocol !== "https:") throw new Error();
      // Where the site serves this job's cutouts from; only an https origin + path is accepted.
      if (typeof parsed.assetBase === "string" && parsed.assetBase.length < 200 && new URL(parsed.assetBase).protocol === "https:") assetBase = parsed.assetBase.replace(/\/$/, "");
    } catch {
      return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Send {\"url\": \"https://…\"}" }));
    }
    if (active >= MAX_ACTIVE) return res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "Busy right now. Try again in a minute." }));
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
    let open = true;
    req.on("close", () => (open = false));
    const send = (event, data) => open && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const beat = setInterval(() => open && res.write(": keep-alive\n\n"), 15000);
    active++;
    try {
      await generate(target.href, send, assetBase);
    } catch (e) {
      console.error(new Date().toISOString(), "job failed:", e?.message ?? e);
      const msg = String(e?.message ?? e);
      send("error", { message: /Blocked|private/.test(msg) ? "That link isn't supported." : msg.slice(0, 200) });
    } finally {
      active--;
      clearInterval(beat);
      res.end();
    }
    return;
  }
  res.writeHead(404).end("not found");
});

await mkdir(JOBS, { recursive: true });
server.listen(PORT, "127.0.0.1", () => console.log(`generator listening on 127.0.0.1:${PORT} (brief via ${VIA}, ${RENDER_JOBS} render slots)`));
