// Product data -> creative brief, written by Kimi K3.1 Pro.
// Direct to Cerebras by default; BRIEF_VIA=openclaw runs it as an OpenClaw agent turn.
import { MODEL as DEFAULT_MODEL, SYSTEM, parse, normalize, untrusted, factsOf, briefRequest, THEMES } from "./core/brief-core.mjs";

export { normalize, THEMES };

const BASE = process.env.LLM_BASE_URL ?? "https://api.cerebras.ai/v1";
const MODEL = process.env.LLM_MODEL ?? DEFAULT_MODEL;
const KEY = process.env.LLM_API_KEY ?? process.env.CEREBRAS_API_KEY;
// One agent turn through the OpenClaw harness (embedded runner, Kimi on Cerebras).
// Runs as the dedicated "brief" agent, which has no tools and no skills (see README):
// scraped text can never reach exec, files or the browser, whatever it says.
// Text-only: the CLI has no image attachment, so colours come from the product facts.
async function viaOpenClaw(product, facts) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { randomUUID } = await import("node:crypto");
  const bin = process.env.OPENCLAW_BIN ?? "openclaw";
  const message = `${SYSTEM}\n\nReply with the JSON object only.\n\n${untrusted(facts)}\n\nImages are indexed 0..${product.images.length - 1}.`;
  const t0 = performance.now();
  const { stdout } = await promisify(execFile)(
    bin,
    ["--profile", process.env.OPENCLAW_PROFILE ?? "cerb", "agent", "--local", "--agent", process.env.OPENCLAW_BRIEF_AGENT ?? "brief", "--json", "--thinking", "low", "--timeout", "300", "--session-id", `brief-${randomUUID()}`, "-m", message],
    { maxBuffer: 1 << 26 },
  );
  const out = JSON.parse(stdout.slice(stdout.indexOf("{")));
  const text = out?.meta?.finalAssistantVisibleText ?? out?.payloads?.[0]?.text ?? "";
  const u = out?.meta?.agentMeta?.usage ?? {};
  return {
    brief: normalize(parse(text), product),
    stats: { model: `openclaw:${out?.meta?.executionTrace?.winnerModel ?? MODEL}`, vision: false, wallSeconds: +((performance.now() - t0) / 1000).toFixed(2), queueSeconds: null, completionSeconds: null, completionTokens: u.output, reasoningTokens: u.reasoningTokens, tps: null },
  };
}

export async function writeBrief(product, { vision = true, effort = "low", imageData = [], via = process.env.BRIEF_VIA } = {}) {
  if (via === "openclaw") {
    const { images, url, source, domain, ...facts } = product;
    return viaOpenClaw(product, { ...facts, imageCount: images.length });
  }
  if (!imageData.length) vision = false;
  if (!KEY) throw new Error("Set CEREBRAS_API_KEY (or LLM_API_KEY)");
  const body = briefRequest(product, { imageData: vision ? imageData : [], effort, model: MODEL });
  const t0 = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    if (vision) {
      console.error(`  vision call failed (${json?.message ?? res.status}); retrying text-only`);
      return writeBrief(product, { vision: false, imageData: [], effort });
    }
    throw new Error(`LLM ${res.status}: ${json?.message ?? JSON.stringify(json)}`);
  }
  const wall = (performance.now() - t0) / 1000;
  const u = json.usage ?? {};
  const ti = json.time_info ?? {};
  const stats = {
    model: MODEL,
    vision,
    wallSeconds: +wall.toFixed(2),
    queueSeconds: ti.queue_time != null ? +ti.queue_time.toFixed(2) : null,
    completionSeconds: ti.completion_time != null ? +ti.completion_time.toFixed(2) : null,
    completionTokens: u.completion_tokens,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
    tps: ti.completion_time ? Math.round(u.completion_tokens / ti.completion_time) : null,
  };
  return { brief: normalize(parse(json.choices[0].message.content ?? ""), product), stats };
}
