#!/usr/bin/env node
// node src/make.mjs <product-url> [more urls…] [--html saved-page.html] [--no-render] [--no-vision] [--render-jobs N]
//
// Everything that can overlap does:
//   - all product links run as separate pipelines at once
//   - within one, every image downloads in parallel, and Kimi starts on the brief as
//     soon as the first four photos are in while the rest keep downloading
//   - renders go through a small pool (--render-jobs, default 2) fed as briefs finish
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrape, download } from "./scrape.mjs";
import { thumbnail } from "./thumb.mjs";
import { writeBrief, normalize } from "./brief.mjs";
import { composeVideo } from "./styles.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const urls = args.filter((a) => /^https?:\/\//.test(a));

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const clock = () => performance.now();
const secs = (t) => +((clock() - t) / 1000).toFixed(2);

// Render pool. HyperFrames serialises renders by default; with the lock off a few
// can share the machine. More than 2-3 at once starve each other on a laptop.
const RENDER_JOBS = Math.max(1, Number(opt("--render-jobs") ?? 2));
let active = 0;
const waiting = [];
async function render(dir) {
  if (active >= RENDER_JOBS) await new Promise((r) => waiting.push(r));
  active++;
  try {
    await run(path.join(ROOT, "node_modules/.bin/hyperframes"), ["render", "--output", "video.mp4", "--quiet"], {
      cwd: dir,
      maxBuffer: 1 << 26,
      env: { ...process.env, HYPERFRAMES_RENDER_LOCK: RENDER_JOBS > 1 ? "off" : (process.env.HYPERFRAMES_RENDER_LOCK ?? "") },
    });
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const writeProject = (dir, product, brief, images) =>
  Promise.all([
    writeFile(path.join(dir, "index.html"), composeVideo(product, brief, images, { style: opt("--style") })),
    writeFile(path.join(dir, "hyperframes.json"), JSON.stringify({ paths: { assets: "assets" } }, null, 2)),
  ]);

if (opt("--build")) {
  // Stage 2 for the OpenClaw skill: the agent has written brief.json next to product.json.
  const dir = path.resolve(opt("--build"));
  const [{ product, images }, raw] = await Promise.all([readFile(path.join(dir, "product.json"), "utf8").then(JSON.parse), readFile(path.join(dir, "brief.json"), "utf8").then(JSON.parse)]);
  await writeProject(dir, product, normalize(raw, product), images);
  if (!flag("--no-render")) await render(dir);
  console.log(`video: ${path.join(dir, flag("--no-render") ? "index.html" : "video.mp4")}`);
  process.exit(0);
}
if (!urls.length) {
  console.error("usage: node src/make.mjs <product-url> [more urls…] [--html file] [--no-render] [--no-vision] [--style depth|classic] [--render-jobs N]");
  process.exit(1);
}


async function makeOne(url, tag) {
  const log = (line) => console.log(`${tag}${line}`);
  const t0 = clock();
  const html = opt("--html") && urls.length === 1 ? await readFile(opt("--html"), "utf8") : undefined;
  const product = await scrape(url, html);
  const timing = { scrape: secs(t0) };
  log(`product: ${product.brand} — ${product.title} (${product.price ?? "no price"}, ${product.images.length} images)`);

  const dir = path.join(ROOT, "videos", slugify(`${product.brand}-${product.title}`));
  await mkdir(path.join(dir, "assets"), { recursive: true });

  // One promise per image; nothing waits on a slow one unless it needs it.
  const tAssets = clock();
  const sources = product.images;
  const downloads = sources.map(async (src, i) => {
    try {
      const tmp = path.join(dir, "assets", `img${i}`);
      const kind = await download(src, tmp);
      const rel = `assets/img${i}.${kind}`;
      await rename(tmp, path.join(dir, rel));
      return { src, rel, kind };
    } catch (e) {
      console.error(`${tag}  skipped image ${i}: ${e.message.slice(0, 60)}`);
      return null;
    }
  });

  if (flag("--scrape-only")) {
    // Stage 1 for the OpenClaw skill: facts + local images, no model call.
    const kept = (await Promise.all(downloads)).filter(Boolean);
    if (!kept.length) throw new Error("No product images could be downloaded");
    product.images = kept.map((k) => k.src);
    const images = kept.map((k) => k.rel);
    await writeFile(path.join(dir, "product.json"), JSON.stringify({ product, images }, null, 2));
    console.log(JSON.stringify({ dir, images: images.map((i) => path.join(dir, i)), product: { ...product, images: undefined, url: undefined } }, null, 1));
    return;
  }

  // The brief only needs the first four photos, so it starts as soon as those land.
  const tBrief = clock();
  const briefJob = (async () => {
    const head = await Promise.all(downloads.slice(0, 4));
    // Indices must line up with what the model is shown, so only use a clean leading run.
    const usable = [];
    for (const h of head) {
      if (!h) break;
      usable.push(h);
    }
    const imageData = [];
    if (!flag("--no-vision")) {
      for (const data of await Promise.all(usable.map((h) => thumbnail(path.join(dir, h.rel), h.kind)))) {
        if (!data) break; // keep indices aligned with what the model is shown
        imageData.push(data);
      }
    }
    return writeBrief(product, { imageData });
  })();

  const [all, { brief: rawBrief, stats }] = await Promise.all([Promise.all(downloads), briefJob]);
  timing.assets = secs(tAssets);
  timing.brief = secs(tBrief);

  // Drop failed images and remap the indices the model chose onto what survived.
  const keptIdx = all.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
  if (!keptIdx.length) throw new Error("No product images could be downloaded");
  const remap = (i) => Math.max(0, keptIdx.indexOf(i));
  const brief = { ...rawBrief, heroImage: remap(rawBrief.heroImage), featureImages: rawBrief.featureImages.map(remap) };
  product.images = keptIdx.map((i) => sources[i]);
  const images = keptIdx.map((i) => all[i].rel);

  log(`brief:   "${brief.hook}" · ${brief.theme} · ${brief.palette.bg}/${brief.palette.accent}`);
  log(`kimi:    ${stats.completionTokens} tokens in ${stats.completionSeconds}s (${stats.tps} tok/s), queue ${stats.queueSeconds}s, wall ${stats.wallSeconds}s, vision=${stats.vision}`);

  await writeProject(dir, product, brief, images);
  timing.previewReady = secs(t0);

  if (!flag("--no-render")) {
    const tRender = clock();
    await render(dir);
    timing.render = secs(tRender);
  }
  timing.total = secs(t0);
  await writeFile(path.join(dir, "run.json"), JSON.stringify({ product, brief, stats, timing }, null, 2));
  log(`timing:  ${JSON.stringify(timing)}`);
  log(`output:  ${path.relative(ROOT, dir)}/${flag("--no-render") ? "index.html" : "video.mp4"}`);
}

const tAll = clock();
const results = await Promise.allSettled(urls.map((u, i) => makeOne(u, urls.length > 1 ? `[${i + 1}/${urls.length}] ` : "")));
const failed = results.map((r, i) => [r, urls[i]]).filter(([r]) => r.status === "rejected");
for (const [r, u] of failed) console.error(`failed:  ${u}\n         ${r.reason?.message ?? r.reason}`);
if (urls.length > 1) console.log(`batch:   ${urls.length - failed.length}/${urls.length} videos in ${secs(tAll)}s wall`);
process.exit(failed.length ? 1 : 0);
