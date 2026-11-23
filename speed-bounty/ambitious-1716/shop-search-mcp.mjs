#!/usr/bin/env node
// Live shop search MCP server (stdio) for the Speed Bounty.
// One tool, search_shop: queries the named Shopify store's own public search
// endpoint live and returns the first in-stock physical product as
// {name, price, url}. No cache, no preset products.
import readline from "node:readline";

const clean = (s) => String(s || "").replace(/&amp;/g, "&").replace(/[\u2018\u2019]/g, "'").replace(/[\u2013\u2014]/g, "-").replace(/[^\x20-\x7e]/g, " ").replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();

async function searchShop(shop, query) {
  const host = String(shop || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return { shop: host, error: "bad shop" };
  const u = `https://${host}/search/suggest.json?q=${encodeURIComponent(query || "gift")}&resources[type]=product&resources[limit]=4`;
  try {
    const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0", accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { shop: host, error: `http ${r.status}` };
    const list = (await r.json())?.resources?.results?.products || [];
    const p = list.find((x) => x.available && !/gift\s*card|e-?gift/i.test(`${x.title} ${x.type} ${x.handle}`));
    if (!p) return { shop: host, error: "no physical product" };
    return { name: clean(p.title), price: Number(p.price).toFixed(2), url: `https://${host}${String(p.url).split("?")[0]}` };
  } catch (e) { return { shop: host, error: String(e.name || e) }; }
}

// Cursor tool: each call searches the next shop in the list live. The cursor
// restarts after the last shop, or after 8 idle seconds (a new session).
const LIST = (process.env.SHOPS || "fellowproducts.com,www.deathwishcoffee.com,ugmonk.com,www.nomadgoods.com,www.tentree.com,www.allbirds.com,magicspoon.com,drinkolipop.com,www.kyliecosmetics.com,www.brooklinen.com,flybyjing.com,brightland.co,corkcicle.com,www.diasporaco.com,goosecreek.com,www.lodgecastiron.com,kikkerland.com,www.naturallife.com,ledergames.com,www.portlandleathergoods.com").split(",");
let cursor = 0, last = 0;
async function nextShop() {
  if (Date.now() - last > 8000 || cursor >= LIST.length) cursor = 0;
  const i = cursor++; last = Date.now();
  const out = await searchShop(LIST[i], "gift"); last = Date.now();
  return { ...out, left: LIST.length - cursor };
}
const NEXT = { name: "next", description: "Search the next shop live; returns its top gift and how many shops are left.", inputSchema: { type: "object", properties: {} } };
const TOOL = { name: "search_shop", description: "Search one online shop live and return its top in-stock product.", inputSchema: { type: "object", properties: { shop: { type: "string", description: "Shop domain" }, query: { type: "string" } }, required: ["shop"] } };
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "shops", version: "1.0.0" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [TOOL, NEXT] } });
  if (m.method === "tools/call") { const a = m.params?.arguments || {}; const out = m.params?.name === "next" ? await nextShop() : await searchShop(a.shop, a.query); return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } }); }
  if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
});
