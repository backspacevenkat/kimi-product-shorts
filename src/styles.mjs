// Video styles. Each takes the same product + brief and stages it differently.
import { compose } from "./compose.mjs";
import { compose3d } from "./compose3d.mjs";
import { composeReel } from "./compose-reel.mjs";

export const STYLES = { depth: compose3d, reel: composeReel, classic: compose };
export const STYLE_LABELS = { depth: "3D showcase", reel: "Story reel", classic: "Clean cards" };
// Order used when one link produces several versions.
export const VERSION_STYLES = ["depth", "reel", "classic"];
export const composeVideo = (product, brief, images, { style = process.env.VIDEO_STYLE ?? "depth", web = false } = {}) =>
  (STYLES[style] ?? compose3d)(product, brief, images, { web });
