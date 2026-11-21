// Product page -> normalized product data.
// Shopify: public <product-url>.json. Everything else: JSON-LD Product + Open Graph tags.
// Amazon pages block plain fetches, so they take pre-captured HTML (see scrapeHtml).

import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch } from "undici";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const strip = (html) =>
  String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const money = (v, currency = "USD") => {
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const sym = { USD: "$", EUR: "€", GBP: "£", CAD: "$", AUD: "$", INR: "₹", SEK: "kr " }[currency] ?? "$";
  return sym + (Number.isInteger(n) ? n : n.toFixed(2));
};

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
    return options.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
  });
}

// undici connects through guardedLookup, so the address that passed the check
// is the one the socket uses.
const dispatcher = new Agent({ connect: { lookup: guardedLookup }, headersTimeout: 20000, bodyTimeout: 30000 });

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
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(current);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Blocked non-http URL: ${u.protocol}`);
    if (u.username || u.password) throw new Error("Blocked URL with credentials");
    // IP-literal hosts never reach the DNS lookup, so check them here.
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isPrivate(host)) throw new Error(`Blocked private or local address: ${u.hostname}`);
    let res;
    try {
      res = await fetch(u, { dispatcher, redirect: "manual", headers: { "user-agent": UA, accept, "accept-language": "en-US,en;q=0.9" } });
    } catch (e) {
      throw new Error(e?.cause?.message ?? e.message);
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      current = new URL(loc, u).href;
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error(`Response too large: ${url}`);
    const buffer = await readCapped(res);
    return { ok: true, status: res.status, headers: res.headers, buffer, text: async () => buffer.toString("utf8"), json: async () => JSON.parse(buffer.toString("utf8")) };
  }
  throw new Error(`Too many redirects: ${url}`);
}

async function shopify(url) {
  const u = new URL(url);
  const m = u.pathname.match(/\/products\/([^/?#]+)/);
  if (!m) return null;
  let data;
  try {
    data = await (await get(`${u.origin}/products/${m[1]}.json`, "application/json")).json();
  } catch {
    return null;
  }
  const p = data?.product;
  if (!p) return null;
  const v = p.variants?.[0] ?? {};
  // .json has no currency; storefront meta does.
  let currency = "USD";
  try {
    const html = await (await get(url)).text();
    currency = html.match(/"currency"\s*:\s*"([A-Z]{3})"/)?.[1] ?? html.match(/Shopify\.currency\s*=\s*\{"active":"([A-Z]{3})"/)?.[1] ?? "USD";
  } catch {}
  const price = money(v.price, currency);
  const compareAt = v.compare_at_price && Number(v.compare_at_price) > Number(v.price) ? money(v.compare_at_price, currency) : null;
  return {
    source: "shopify",
    url,
    domain: u.hostname.replace(/^www\./, ""),
    brand: p.vendor || u.hostname.replace(/^www\./, "").split(".")[0],
    title: p.title,
    price,
    compareAt,
    description: strip(p.body_html).slice(0, 1500),
    bullets: [],
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 12) : String(p.tags || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12),
    images: (p.images ?? []).map((i) => i.src).slice(0, 8),
  };
}

function fromJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  for (const raw of blocks) {
    let j;
    try {
      j = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const nodes = [].concat(j?.["@graph"] ?? j);
    const p = nodes.find((n) => [].concat(n?.["@type"] ?? []).includes("Product"));
    if (p) return p;
  }
  return null;
}

const meta = (html, name) =>
  html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ??
  html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, "i"))?.[1];

function amazon(html, url) {
  const title = strip(html.match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "");
  if (!title) return null;
  const images = [...new Set([...html.matchAll(/"hiRes":"(https:[^"]+)"/g)].map((m) => m[1]))];
  if (!images.length) {
    const land = html.match(/id="landingImage"[^>]+data-old-hires="([^"]+)"/)?.[1] ?? html.match(/id="landingImage"[^>]+src="([^"]+)"/)?.[1];
    if (land) images.push(land);
  }
  const bulletBlock = html.match(/id="feature-bullets"[\s\S]*?<\/ul>/)?.[0] ?? "";
  const bullets = [...bulletBlock.matchAll(/<span class="a-list-item[^"]*">([\s\S]*?)<\/span>/g)].map((m) => strip(m[1])).filter((s) => s.length > 8).slice(0, 6);
  const priceRaw = html.match(/class="a-price[^"]*"[^>]*>\s*<span class="a-offscreen">([^<]+)</)?.[1];
  const listRaw = html.match(/class="a-price a-text-price"[^>]*>\s*<span class="a-offscreen">([^<]+)</)?.[1];
  const brandRaw = strip(html.match(/id="bylineInfo"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "");
  const brand = brandRaw.replace(/^(Visit the|Brand:)\s*/i, "").replace(/\s*Store$/i, "").trim();
  const price = priceRaw?.trim() || null;
  const compareAt = listRaw && listRaw.trim() !== price ? listRaw.trim() : null;
  return {
    source: "amazon",
    url,
    domain: new URL(url).hostname.replace(/^www\./, ""),
    brand: brand || "Amazon",
    title,
    price,
    compareAt,
    description: bullets.join(" "),
    bullets,
    tags: [],
    images: images.slice(0, 8),
  };
}

export function scrapeHtml(html, url) {
  const u = new URL(url);
  if (/amazon\./.test(u.hostname)) {
    const a = amazon(html, url);
    if (a) return a;
  }
  const p = fromJsonLd(html);
  const offer = [].concat(p?.offers ?? [])[0] ?? {};
  const images = [].concat(p?.image ?? []).map((i) => (typeof i === "string" ? i : i?.url)).filter(Boolean);
  const og = meta(html, "og:image");
  if (og && !images.includes(og)) images.push(og);
  const title = p?.name ?? meta(html, "og:title") ?? strip(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  if (!title || !images.length) throw new Error(`No product data found at ${url}`);
  return {
    source: "generic",
    url,
    domain: u.hostname.replace(/^www\./, ""),
    brand: (typeof p?.brand === "string" ? p.brand : p?.brand?.name) ?? meta(html, "og:site_name") ?? u.hostname.replace(/^www\./, "").split(".")[0],
    title: strip(title),
    price: money(offer.price ?? offer.lowPrice ?? meta(html, "product:price:amount"), offer.priceCurrency ?? meta(html, "product:price:currency") ?? "USD"),
    compareAt: null,
    description: strip(p?.description ?? meta(html, "og:description") ?? "").slice(0, 1500),
    bullets: [],
    tags: [],
    images: images.map((i) => new URL(i, url).href).slice(0, 8),
  };
}

export async function scrape(url, html) {
  if (html) return scrapeHtml(html, url);
  const s = await shopify(url);
  if (s && s.images.length) return s;
  return scrapeHtml(await (await get(url)).text(), url);
}

export async function download(src, dest) {
  const { writeFile } = await import("node:fs/promises");
  const res = await get(src, "image/avif,image/webp,image/*,*/*");
  const type = res.headers.get("content-type") ?? "";
  if (type && !/^image\//i.test(type)) throw new Error(`Not an image (${type.slice(0, 40)})`);
  await writeFile(dest, res.buffer);
  return type;
}
