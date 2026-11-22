// Cloudflare Worker: the public front door.
//   GET  /api/config            -> { clientId, limit }
//   GET  /api/me                -> { email, used, limit }            (Google sign-in required)
//   POST /api/generate {url}    -> server-sent events from the generator (sign-in + quota)
//   GET  /api/video/<id>.mp4    -> the rendered MP4 for a finished job
//   GET  /media/*.mp4           -> gallery videos with byte-range support
//   everything else             -> static assets
//
// The Worker owns identity and limits. Generation (model key, Chrome, FFmpeg) runs on
// a separate machine reached through a tunnel; only this Worker knows the shared key.

const json = (data, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const LIMIT = (env) => Number(env.GEN_LIMIT ?? 2);

// ---------- Google sign-in ------------------------------------------------
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
let jwks = { keys: [], at: 0 };

async function googleKeys() {
  if (Date.now() - jwks.at < 3600_000 && jwks.keys.length) return jwks.keys;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw new Error("Could not load Google's signing keys");
  jwks = { keys: (await res.json()).keys, at: Date.now() };
  return jwks.keys;
}

// Verifies a Google ID token: signature, issuer, audience, expiry, verified email.
async function verifyGoogle(token, env) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const now = Date.now() / 1000;
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) return null;
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !(claims.exp > now) || claims.email_verified !== true || !claims.sub) return null;
  return { sub: String(claims.sub), email: String(claims.email ?? "") };
}

async function requireUser(request, env) {
  if (!env.GOOGLE_CLIENT_ID) return { error: json({ error: "Sign-in isn't configured yet." }, 503) };
  const auth = request.headers.get("authorization") ?? "";
  const user = auth.startsWith("Bearer ") ? await verifyGoogle(auth.slice(7), env).catch(() => null) : null;
  return user ? { user } : { error: json({ error: "Please sign in with Google first." }, 401) };
}

// Per-user counter. One Durable Object per Google account, so reserve and refund are
// atomic, relative operations: concurrent requests cannot both pass the limit, and a
// refund can never write back a stale total.
export class Quota {
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    const { op, limit } = await request.json();
    let used = (await this.state.storage.get("used")) ?? 0;
    let ok = true;
    if (op === "reserve") {
      ok = used < limit;
      if (ok) await this.state.storage.put("used", ++used);
    } else if (op === "refund") {
      if (used > 0) await this.state.storage.put("used", --used);
    }
    return Response.json({ ok, used });
  }
}
const quota = async (env, sub, op, limit = 0) => {
  const stub = env.QUOTA.get(env.QUOTA.idFromName(sub));
  return (await stub.fetch("https://quota/", { method: "POST", body: JSON.stringify({ op, limit }) })).json();
};
const getUsed = async (env, sub) => (await quota(env, sub, "get")).used;

// ---------- link validation -----------------------------------------------
function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("That doesn't look like a link.");
  }
  if (u.protocol !== "https:") throw new Error("Only https links are supported.");
  if (u.username || u.password || (u.port && u.port !== "443")) throw new Error("That link isn't supported.");
  const h = u.hostname.toLowerCase();
  const ipLiteral = /^\[.*\]$/.test(h) || /^[0-9.]+$/.test(h) || /^0x/i.test(h);
  const internal = h === "localhost" || !h.includes(".") || /\.(local|localhost|internal|lan|home|corp|test|invalid|example)$/.test(h);
  if (ipLiteral || internal) throw new Error("That link isn't supported.");
  u.hash = "";
  return u;
}

// ---------- generator proxy -----------------------------------------------
const backend = async (env) => (await env.STATE.get("backend_url"))?.replace(/\/$/, "") ?? null;

async function generate(request, env, ctx) {
  const { user, error } = await requireUser(request, env);
  if (error) return error;

  let target;
  try {
    const body = await request.json();
    if (typeof body?.url !== "string" || body.url.length > 600) throw new Error("That doesn't look like a link.");
    target = assertPublicUrl(body.url.trim());
  } catch (e) {
    return json({ error: e instanceof SyntaxError ? "Send JSON: {\"url\": \"https://…\"}" : e.message }, 400);
  }

  if (env.LIMITER) {
    const { success } = await env.LIMITER.limit({ key: user.sub });
    if (!success) return json({ error: "Too many requests. Give it a minute." }, 429);
  }
  const base = await backend(env);
  if (!base || !env.BACKEND_KEY) return json({ error: "The generator is offline right now." }, 503);

  // Reserve a slot atomically; hand exactly one back if the job fails before producing a video.
  const limit = LIMIT(env);
  const slot = await quota(env, user.sub, "reserve", limit);
  if (!slot.ok) return json({ error: `You've used your ${limit} videos. Thanks for trying it!`, used: slot.used, limit }, 403);
  let refunded = false;
  const refund = () => {
    if (refunded) return Promise.resolve();
    refunded = true;
    return quota(env, user.sub, "refund");
  };

  let upstream;
  try {
    upstream = await fetch(`${base}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-backend-key": env.BACKEND_KEY },
      body: JSON.stringify({ url: target.href }),
    });
  } catch {
    await refund();
    return json({ error: "The generator is offline right now." }, 503);
  }
  if (!upstream.ok || !upstream.body) {
    await refund();
    const j = await upstream.json().catch(() => ({}));
    return json({ error: j.error ?? "The generator is offline right now." }, upstream.status === 503 ? 503 : 502);
  }

  let sawResult = false;
  const dec = new TextDecoder();
  let tail = "";
  const watch = new TransformStream({
    transform(chunk, controller) {
      const text = tail + dec.decode(chunk, { stream: true });
      if (text.includes("event: result")) sawResult = true;
      tail = text.slice(-20);
      controller.enqueue(chunk);
    },
    flush() {
      if (!sawResult) ctx.waitUntil(refund());
    },
  });
  return new Response(upstream.body.pipeThrough(watch), {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

async function video(env, id) {
  const base = await backend(env);
  if (!base || !env.BACKEND_KEY) return json({ error: "The generator is offline right now." }, 503);
  const res = await fetch(`${base}/video/${id}.mp4`, { headers: { "x-backend-key": env.BACKEND_KEY } });
  if (!res.ok) return json({ error: "That video isn't available." }, 404);
  return new Response(res.body, {
    headers: { "content-type": "video/mp4", "content-disposition": `attachment; filename="product-short-${id.slice(0, 8)}.mp4"`, "cache-control": "private, max-age=3600" },
  });
}

// ---------- gallery media with byte ranges --------------------------------
async function media(request, env, url) {
  const asset = await env.ASSETS.fetch(new Request(url, { method: "GET" }));
  if (!asset.ok) return asset;
  const buf = await asset.arrayBuffer();
  const size = buf.byteLength;
  const headers = new Headers({ "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "public, max-age=3600" });
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (!m || (m[1] === "" && m[2] === "")) {
    headers.set("content-length", String(size));
    return new Response(request.method === "HEAD" ? null : buf, { status: 200, headers });
  }
  const start = m[1] === "" ? Math.max(size - Number(m[2]), 0) : Number(m[1]);
  const end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(request.method === "HEAD" ? null : buf.slice(start, end + 1), { status: 206, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p.startsWith("/api/")) {
      // Browser calls must come from this site.
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({ error: "Cross-site requests are not allowed." }, 403);

      if (p === "/api/config" && request.method === "GET") return json({ clientId: env.GOOGLE_CLIENT_ID ?? null, limit: LIMIT(env) });
      if (p === "/api/me" && request.method === "GET") {
        const { user, error } = await requireUser(request, env);
        if (error) return error;
        return json({ email: user.email, used: await getUsed(env, user.sub), limit: LIMIT(env) });
      }
      if (p === "/api/generate") return request.method === "POST" ? generate(request, env, ctx) : json({ error: "POST only" }, 405);
      const v = /^\/api\/video\/([0-9a-f-]{36}-[0-9])\.mp4$/.exec(p);
      if (v && request.method === "GET") return video(env, v[1]);
      return json({ error: "Not found" }, 404);
    }
    if (p.startsWith("/media/") && p.endsWith(".mp4") && (request.method === "GET" || request.method === "HEAD")) return media(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
