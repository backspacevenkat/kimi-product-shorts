#!/usr/bin/env node
// Builds the showcase site into site/dist from videos/*/run.json.
// node site/build.mjs [--render]   (--render re-renders every video first and records the time)
import { readdir, readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "site", "dist");
const RENDER = process.argv.includes("--render");

await rm(DIST, { recursive: true, force: true });
await mkdir(path.join(DIST, "media"), { recursive: true });

const items = [];
for (const slug of (await readdir(path.join(ROOT, "videos"))).sort()) {
  const dir = path.join(ROOT, "videos", slug);
  const runFile = path.join(dir, "run.json");
  if (!existsSync(runFile) || !existsSync(path.join(dir, "index.html"))) continue;
  const data = JSON.parse(await readFile(runFile, "utf8"));

  if (RENDER) {
    const t = performance.now();
    await run(path.join(ROOT, "node_modules/.bin/hyperframes"), ["render", "--output", "video.mp4", "--quiet"], { cwd: dir, maxBuffer: 1 << 26 });
    data.timing.render = +((performance.now() - t) / 1000).toFixed(1);
    await writeFile(runFile, JSON.stringify(data, null, 2));
    console.log(`rendered ${slug} in ${data.timing.render}s`);
  }
  const src = path.join(dir, "video.mp4");
  if (!existsSync(src)) continue;

  // Web copy: 720x1280, small enough to stream instantly; poster from the hero scene.
  await run("ffmpeg", ["-v", "error", "-y", "-i", src, "-vf", "scale=720:-2", "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", path.join(DIST, "media", `${slug}.mp4`)]);
  await run("ffmpeg", ["-v", "error", "-y", "-ss", "4.9", "-i", src, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", path.join(DIST, "media", `${slug}.jpg`)]);

  const { product, brief, stats, timing } = data;
  items.push({
    slug,
    brand: product.brand,
    title: product.title,
    price: product.price,
    compareAt: product.compareAt,
    domain: product.domain,
    url: product.url,
    source: product.source,
    imageCount: product.images.length,
    brief,
    stats: {
      via: String(stats.model).startsWith("openclaw:") ? "openclaw" : "cerebras",
      vision: !!stats.vision,
      writeSeconds: stats.completionSeconds,
      queueSeconds: stats.queueSeconds,
      wallSeconds: stats.wallSeconds,
      tokens: stats.completionTokens,
      tps: stats.tps,
    },
    timing: { scrape: timing.scrape, assets: timing.assets ?? null, render: timing.render ?? null },
  });
}

await writeFile(path.join(DIST, "data.json"), JSON.stringify({ builtAt: new Date().toISOString(), items }));
for (const page of ["index.html", "privacy.html"]) await copyFile(path.join(ROOT, "site", page), path.join(DIST, page));
console.log(`site/dist ready: ${items.length} videos`);
