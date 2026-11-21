// Product page -> normalized product data.
// Shopify: public <product-url>.json. Everything else: JSON-LD Product + Open Graph tags.
// Amazon pages block plain fetches, so they take pre-captured HTML (see scrapeHtml).

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
// so: http(s) only, no private/loopback/link-local targets, redirects re-checked
// hop by hop, and a size cap.
const MAX_BYTES = 25 * 1024 * 1024;

function isPrivate(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivate(v.slice(7));
  return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff");
}

async function assertPublic(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Blocked non-http URL: ${u.protocol}`);
  if (u.username || u.password) throw new Error("Blocked URL with credentials");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error(`Blocked private or local address: ${u.hostname}`);
  return u;
}

async function get(url, accept = "text/html") {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    await assertPublic(current);
    const res = await fetch(current, { headers: { "user-agent": UA, accept, "accept-language": "en-US,en;q=0.9" }, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location"), current).href;
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error(`Response too large: ${url}`);
    return res;
  }
  throw new Error(`Too many redirects: ${url}`);
}

async function body(res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("Response too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
  await writeFile(dest, await body(res));
  return type;
}
