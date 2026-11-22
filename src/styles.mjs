// Video styles. Each takes the same product + brief and stages it differently.
import { compose } from "./compose.mjs";
import { compose3d } from "./compose3d.mjs";
import { composeReel } from "./compose-reel.mjs";

export const STYLES = { depth: compose3d, reel: composeReel, classic: compose };
export const STYLE_LABELS = { depth: "3D showcase", reel: "Story reel", classic: "Clean cards" };
// Order used when one link produces several versions.
export const VERSION_STYLES = ["depth", "reel", "classic"];
// Where each style cuts, pops its price and starts its call to action (seconds),
// so the soundtrack can land a whoosh, a pop and a chime on them.
export const SOUND_CUES = {
  depth: { cuts: [2.7, 6.4, 11.0], pops: [3.2], chime: 11.15 },
  reel: { cuts: [2.8, 6.1, 7.65, 9.2, 10.75], pops: [3.8], chime: 10.9 },
  classic: { cuts: [2.8, 6.6, 11.4], pops: [3.55], chime: 11.55 },
};
export const composeVideo = (product, brief, images, { style = process.env.VIDEO_STYLE ?? "depth", web = false, audio = null, cutouts = [] } = {}) =>
  (STYLES[style] ?? compose3d)(product, brief, images, { web, audio, cutouts });
