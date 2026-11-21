// Static assets do not answer byte-range requests, and Safari will not play a
// <video> without them. This serves the small MP4s with proper 206 responses.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/media/") || !url.pathname.endsWith(".mp4") || (request.method !== "GET" && request.method !== "HEAD")) {
      return env.ASSETS.fetch(request);
    }
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
    let start = m[1] === "" ? Math.max(size - Number(m[2]), 0) : Number(m[1]);
    let end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start >= size || start > end) {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(request.method === "HEAD" ? null : buf.slice(start, end + 1), { status: 206, headers });
  },
};
