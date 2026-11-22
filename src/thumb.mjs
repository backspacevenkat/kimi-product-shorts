// Small JPEG data URI of a downloaded product photo, for the model to look at.
// ffmpeg is pinned to one image decoder and to local files only: it will not
// guess a container format or follow any network or nested-file reference.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const DEMUXER = { jpg: "jpeg_pipe", png: "png_pipe", webp: "webp_pipe" };

export async function thumbnail(file, kind) {
  const demuxer = DEMUXER[kind];
  if (!demuxer) return null; // e.g. AVIF: skip rather than let ffmpeg pick a container demuxer
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-protocol_whitelist", "file", "-f", demuxer, "-i", file, "-vf", "scale=448:448:force_original_aspect_ratio=decrease", "-frames:v", "1", "-q:v", "6", "-f", "image2pipe", "-c:v", "mjpeg", "-"],
    { encoding: "buffer", maxBuffer: 1 << 24 },
  );
  return `data:image/jpeg;base64,${stdout.toString("base64")}`;
}
