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
import { mkdir, writeFile, rename, stat, cp } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrape, download } from "./scrape.mjs";
import { thumbnail } from "./thumb.mjs";
import { writeBrief } from "./brief.mjs";
import { MODEL, briefRequest, normalizeVariants, parse } from "./core/brief-core.mjs";
import { composeVideo, VERSION_STYLES, STYLE_LABELS } from "./styles.mjs";

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
  const body = JSON.stringify(briefRequest(product, { imageData, stream: true, variants: true }));
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
    briefs: normalizeVariants(parse(content), product, VERSION_STYLES.length),
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

let active = 0;

async function generate(url, send) {
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
  const [all, { briefs: raws, stats }] = await Promise.all([Promise.all(downloads), briefJob]);

  const keptIdx = all.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
  if (!keptIdx.length) throw new Error("Couldn't download that product's photos.");
  const remap = (i) => Math.max(0, keptIdx.indexOf(i));
  product.images = keptIdx.map((i) => sources[i]);
  const local = keptIdx.map((i) => all[i].rel);
  const remote = product.images.map((s) => sized(s, 1080));

  // One version per style, each with its own creative angle. Browser versions first.
  const versions = raws.map((raw, n) => {
    const style = VERSION_STYLES[n];
    const brief = { ...raw, heroImage: remap(raw.heroImage), featureImages: raw.featureImages.map(remap) };
    return { n, style, label: STYLE_LABELS[style], brief };
  });
  send("result", { id, stats: { ...stats, scrapeSeconds }, versions: versions.map((v) => ({ ...v, html: composeVideo(product, v.brief, remote, { style: v.style, web: true }) })) });

  // Then the MP4s, through the render pool.
  send("status", { stage: "rendering" });
  await Promise.all(
    versions.map(async (v) => {
      const vdir = path.join(dir, `v${v.n}`);
      await mkdir(vdir, { recursive: true });
      await Promise.all([
        cp(path.join(dir, "assets"), path.join(vdir, "assets"), { recursive: true }),
        writeFile(path.join(vdir, "index.html"), composeVideo(product, v.brief, local, { style: v.style })),
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

  const m = /^\/video\/([0-9a-f-]{36})-([0-9])\.mp4$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const file = path.join(JOBS, m[1], `v${m[2]}`, "video.mp4");
    try {
      const s = await stat(file);
      res.writeHead(200, { "content-type": "video/mp4", "content-length": s.size });
      return createReadStream(file).pipe(res);
    } catch {
      return res.writeHead(404).end("not found");
    }
  }

  if (url.pathname === "/generate" && req.method === "POST") {
    let body = "";
    for await (const c of req) {
      body += c;
      if (body.length > 4000) return res.writeHead(413).end();
    }
    let target;
    try {
      target = new URL(JSON.parse(body).url);
      if (target.protocol !== "https:") throw new Error();
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
      await generate(target.href, send);
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
