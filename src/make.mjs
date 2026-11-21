#!/usr/bin/env node
// node src/make.mjs <product-url> [--html saved-page.html] [--no-render] [--no-vision]
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrape, download } from "./scrape.mjs";
import { writeBrief, normalize } from "./brief.mjs";
import { compose } from "./compose.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const url = args.find((a) => /^https?:\/\//.test(a));
const render = async (dir) => run(path.join(ROOT, "node_modules/.bin/hyperframes"), ["render", "--output", "video.mp4", "--quiet"], { cwd: dir, maxBuffer: 1 << 26 });

if (opt("--build")) {
  // Stage 2 for the OpenClaw skill: the agent has written brief.json next to product.json.
  const dir = path.resolve(opt("--build"));
  const { product, images } = JSON.parse(await readFile(path.join(dir, "product.json"), "utf8"));
  const brief = normalize(JSON.parse(await readFile(path.join(dir, "brief.json"), "utf8")), product);
  await writeFile(path.join(dir, "index.html"), compose(product, brief, images));
  await writeFile(path.join(dir, "hyperframes.json"), JSON.stringify({ paths: { assets: "assets" } }, null, 2));
  if (!flag("--no-render")) await render(dir);
  console.log(`video: ${path.join(dir, flag("--no-render") ? "index.html" : "video.mp4")}`);
  process.exit(0);
}
if (!url) {
  console.error("usage: node src/make.mjs <product-url> [--html file] [--no-render] [--no-vision]");
  process.exit(1);
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const ext = (type, src) => (/png/.test(type) ? "png" : /webp/.test(type) ? "webp" : /avif/.test(type) ? "avif" : /\.png(\?|$)/i.test(src) ? "png" : "jpg");
const clock = () => performance.now();
const secs = (t) => +((clock() - t) / 1000).toFixed(2);

const t0 = clock();
let t = clock();
const html = opt("--html") ? await readFile(opt("--html"), "utf8") : undefined;
const product = await scrape(url, html);
const timing = { scrape: secs(t) };
console.log(`product: ${product.brand} — ${product.title} (${product.price ?? "no price"}, ${product.images.length} images)`);

const dir = path.join(ROOT, "videos", slugify(`${product.brand}-${product.title}`));
await mkdir(path.join(dir, "assets"), { recursive: true });

// Images first (Kimi needs them as data URIs), then the brief.
t = clock();
const fetched = await Promise.all(
  product.images.map(async (src, i) => {
    try {
      const tmp = path.join(dir, "assets", `img${i}`);
      const type = await download(src, tmp);
      const rel = `assets/img${i}.${ext(type, src)}`;
      await run("mv", [tmp, path.join(dir, rel)]);
      return { src, rel };
    } catch (e) {
      console.error(`  skipped image ${i}: ${e.message.slice(0, 60)}`);
      return null;
    }
  }),
);
const kept = fetched.filter(Boolean);
if (!kept.length) throw new Error("No product images could be downloaded");
product.images = kept.map((k) => k.src);
const images = kept.map((k) => k.rel);
if (flag("--scrape-only")) {
  // Stage 1 for the OpenClaw skill: facts + local images, no model call.
  await writeFile(path.join(dir, "product.json"), JSON.stringify({ product, images }, null, 2));
  console.log(JSON.stringify({ dir, images: images.map((i) => path.join(dir, i)), product: { ...product, images: undefined, url: undefined } }, null, 1));
  process.exit(0);
}
const imageData = flag("--no-vision")
  ? []
  : await Promise.all(
      images.slice(0, 4).map(async (rel) => {
        const { stdout } = await run("ffmpeg", ["-v", "error", "-i", path.join(dir, rel), "-vf", "scale=448:448:force_original_aspect_ratio=decrease", "-frames:v", "1", "-q:v", "6", "-f", "image2pipe", "-c:v", "mjpeg", "-"], { encoding: "buffer", maxBuffer: 1 << 24 });
        return `data:image/jpeg;base64,${stdout.toString("base64")}`;
      }),
    );
timing.assets = secs(t);
t = clock();
const { brief, stats } = await writeBrief(product, { imageData });
timing.brief = secs(t);
console.log(`brief:   "${brief.hook}" · ${brief.theme} · ${brief.palette.bg}/${brief.palette.accent}`);
console.log(`kimi:    ${stats.completionTokens} tokens in ${stats.completionSeconds}s (${stats.tps} tok/s), queue ${stats.queueSeconds}s, wall ${stats.wallSeconds}s, vision=${stats.vision}`);

await writeFile(path.join(dir, "index.html"), compose(product, brief, images));
await writeFile(path.join(dir, "hyperframes.json"), JSON.stringify({ paths: { assets: "assets" } }, null, 2));
timing.previewReady = secs(t0);

if (!flag("--no-render")) {
  t = clock();
  await render(dir);
  timing.render = secs(t);
}
timing.total = secs(t0);
await writeFile(path.join(dir, "run.json"), JSON.stringify({ product, brief, stats, timing }, null, 2));
console.log(`timing:  ${JSON.stringify(timing)}`);
console.log(`output:  ${path.relative(ROOT, dir)}/${flag("--no-render") ? "index.html" : "video.mp4"}`);
