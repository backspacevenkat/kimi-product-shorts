// Product page -> normalized product data.
// Shopify: public <product-url>.json. Everything else: JSON-LD Product + Open Graph tags.
// Amazon pages block plain fetches, so they take pre-captured HTML (see scrapeHtml).

import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Agent, fetch } from "undici";
import { UA, scrapeHtml, shopifyHandle, shopifyProduct, currencyFromHtml } from "./core/parse.mjs";

export { scrapeHtml };

const execFileP = promisify(execFile);

// Every fetch goes through here. URLs come from user input and from scraped pages,
// so: http(s) only, no private/reserved targets, redirects re-checked hop by hop,
// and a size cap. The address check runs inside the socket's DNS lookup, so the
// address that was validated is the address that gets connected to (no rebinding gap).
const MAX_BYTES = 25 * 1024 * 1024;

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 96], // unspecified, loopback and IPv4-compatible (IPv4-mapped is unwrapped in isPrivate)
  ["64:ff9b::", 96], ["64:ff9b:1::", 48], // NAT64
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], // discard, special, docs, 6to4
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) blocked.addSubnet(net, bits, "ipv6");

// Trailing 32 bits of an IPv6 address as dotted IPv4, whatever notation was used.
function embeddedV4(ip) {
  const tail = ip.split(":").slice(-2);
  if (tail[1]?.includes(".")) return tail[1];
  const [hi, lo] = tail.map((h) => parseInt(h || "0", 16));
  if (![hi, lo].every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)) return null;
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

export function isPrivate(ip) {
  const fam = isIP(ip);
  if (fam === 4) return blocked.check(ip, "ipv4");
  if (fam !== 6) return true; // unparseable: refuse
  if (blocked.check(ip, "ipv6")) return true;
  const v = ip.toLowerCase();
  if (/^(::ffff:|::|64:ff9b::)/.test(v)) {
    const v4 = embeddedV4(v);
    return !v4 || isIP(v4) !== 4 || blocked.check(v4, "ipv4");
  }
  return false;
}

// DNS lookup used by the socket itself: every candidate address must be public.
function guardedLookup(hostname, options, cb) {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => isPrivate(a.address));
    if (bad || !addrs.length) return cb(new Error(`Blocked private or local address: ${hostname}`));
    // IPv4 first: many networks advertise IPv6 they cannot route, which shows up as connect timeouts.
    addrs.sort((a, b) => a.family - b.family);
    return options.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
  });
}

// undici connects through guardedLookup, so the address that passed the check
// is the one the socket uses.
const dispatcher = new Agent({ connect: { lookup: guardedLookup, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 400, timeout: 15000 }, headersTimeout: 20000, bodyTimeout: 30000 });


// Alternative transport (FETCH_VIA=curl). Some store bot filters rate-limit Node's
// TLS client but serve curl. The guard is unchanged: the hostname is resolved and
// checked here, and curl is pinned to that exact address with --resolve.
const VIA_CURL = process.env.FETCH_VIA === "curl";
const resolvePublic = (hostname) =>
  new Promise((resolve, reject) => guardedLookup(hostname, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs[0]))));

async function curlOnce(u, accept) {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addr = isIP(host) ? { address: host, family: isIP(host) } : await resolvePublic(host);
  const pin = `${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}:${addr.family === 6 ? `[${addr.address}]` : addr.address}`;
  const { stdout } = await execFileP(
    "curl",
    ["-sS", "--proto", "=http,https", "--max-redirs", "0", "--max-time", "25", "--max-filesize", String(MAX_BYTES), "--resolve", pin, "--compressed",
      "-A", UA, "-H", `accept: ${accept}`, "-H", "accept-language: en-US,en;q=0.9", "-D", "-", "-o", "-", "--", u.href],
    { encoding: "buffer", maxBuffer: MAX_BYTES + (1 << 16) },
  );
  // Headers end at the first blank line (no redirects are followed, so one block).
  const cut = stdout.indexOf("\r\n\r\n");
  const head = stdout.subarray(0, cut).toString("latin1").split("\r\n");
  const status = Number(head[0].split(" ")[1]);
  const headers = new Map(head.slice(1).map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
  return { status, headers: { get: (n) => headers.get(n.toLowerCase()) ?? null }, buffer: stdout.subarray(cut + 4) };
}

async function readCapped(res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("Response too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function get(url, accept = "text/html") {
  let current = url;
  let retries = 0;
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(current);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Blocked non-http URL: ${u.protocol}`);
    if (u.username || u.password) throw new Error("Blocked URL with credentials");
    // IP-literal hosts never reach the DNS lookup, so check them here.
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isPrivate(host)) throw new Error(`Blocked private or local address: ${u.hostname}`);
    let res;
    try {
      res = VIA_CURL ? await curlOnce(u, accept) : await fetch(u, { dispatcher, redirect: "manual", headers: { "user-agent": UA, accept, "accept-language": "en-US,en;q=0.9" } });
    } catch (e) {
      throw new Error(e?.cause?.message ?? e.message);
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      current = new URL(loc, u).href;
      continue;
    }
    // Stores rate-limit by IP. Back off briefly and try again before giving up.
    if (res.status === 429 && retries < 3) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, [1200, 3000, 6000][retries++]));
      hop--;
      continue;
    }
    if (res.status === 429) throw new Error("That store is rate-limiting requests right now. Try again in a minute.");
    if (res.status < 200 || res.status >= 300) throw new Error(`${res.status} fetching ${url}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error(`Response too large: ${url}`);
    const buffer = res.buffer ?? (await readCapped(res));
    return { ok: true, status: res.status, headers: res.headers, buffer, text: async () => buffer.toString("utf8"), json: async () => JSON.parse(buffer.toString("utf8")) };
  }
  throw new Error(`Too many redirects: ${url}`);
}

// The product JSON and the storefront page (for currency) are fetched together.
async function shopify(url) {
  const handle = shopifyHandle(url);
  if (!handle) return null;
  const u = new URL(url);
  const [json, html] = await Promise.all([
    get(`${u.origin}/products/${handle}.json`, "application/json").then((r) => r.json()).catch(() => null),
    get(url).then((r) => r.text()).catch(() => ""),
  ]);
  if (!json) return html ? { html } : null;
  return shopifyProduct(json, url, currencyFromHtml(html));
}

export async function scrape(url, html) {
  if (html) return scrapeHtml(html, url);
  const s = await shopify(url);
  if (s?.images?.length) return s;
  // Not Shopify (or no JSON): reuse the page we already fetched if we have it.
  return scrapeHtml(s?.html ?? (await (await get(url)).text()), url);
}

// What the bytes actually are, whatever the URL or content-type header claims.
export function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.toString("latin1", 4, 8) === "ftyp" && /^(avif|avis)$/.test(buf.toString("latin1", 8, 12))) return "avif";
  return null;
}

// Saves a product photo. Anything that is not a real JPEG, PNG, WebP or AVIF is
// refused, so a hostile page cannot hand later tools a playlist or script
// dressed up as an image. Returns the detected kind.
export async function download(src, dest) {
  const { writeFile } = await import("node:fs/promises");
  const res = await get(src, "image/avif,image/webp,image/*,*/*");
  const kind = sniffImage(res.buffer);
  if (!kind) throw new Error("Not a supported image");
  await writeFile(dest, res.buffer);
  return kind;
}
