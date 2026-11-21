# Kimi Product Shorts

Paste a product link, get a 15-second vertical product video.

Built for the Cerebras x Kimi K3.1 Pro x OpenClaw hackathon.

## How it works

1. **Scrape** – reads title, price, description and photos from the product page (Shopify stores via their public product JSON; other stores via JSON-LD / Open Graph).
2. **Direct** – Kimi K3.1 Pro on Cerebras looks at the product photos and writes a creative brief: hook, tagline, three benefits, call to action, colours and one of four visual styles.
3. **Compose and render** – a designed [HyperFrames](https://github.com/heygen-com/hyperframes) template turns the brief into an HTML composition and renders it to MP4. Layout and motion are fixed code, so the model cannot produce a broken layout.

## Setup

Requires Node 24.16+ and FFmpeg.

```bash
npm ci
export CEREBRAS_API_KEY=...   # never commit this
```

## Usage

```bash
# Direct to Cerebras (uses product photos)
node src/make.mjs https://store.example.com/products/some-product

# Brief written by an OpenClaw agent turn (text-only)
BRIEF_VIA=openclaw node src/make.mjs https://store.example.com/products/some-product

# A page saved from your browser (for sites that block fetches)
node src/make.mjs https://www.example.com/dp/XXXX --html saved-page.html
```

Output lands in `videos/<product>/video.mp4`, with `run.json` holding the brief and timings.

### OpenClaw

The project expects an OpenClaw profile whose default model is Kimi on Cerebras:

```bash
openclaw --profile cerb config set models.providers.cerebras '{"baseUrl":"https://api.cerebras.ai/v1","apiKey":"CEREBRAS_API_KEY","api":"openai-completions","models":[{"id":"moonshotai-kimi-k3.1-pro-trial","name":"Kimi K3.1 Pro (Cerebras)","reasoning":true,"input":["text","image"]}]}' --strict-json --merge
openclaw --profile cerb config set agents.defaults.model.primary cerebras/moonshotai-kimi-k3.1-pro-trial
```

`apiKey` is the *name* of the environment variable, not the key itself.

The brief turn receives text scraped from the web, so it runs as a separate agent with no tools and no skills:

```bash
openclaw --profile cerb config set tools.toolSearch false --strict-json
openclaw --profile cerb config set agents.list '[{"id":"main","default":true},{"id":"brief","skills":[],"tools":{"profile":"minimal","deny":["*"]}}]' --strict-json
```

`openclaw-skill/product-video/` is an agent skill for the full flow (send the agent a link, it scrapes, writes the brief and renders). Copy it into your OpenClaw workspace `skills/` folder and set `PRODUCT_SHORTS_ROOT` to this repository's path. It is experimental.

## Security notes

- Scraped page text is untrusted. It is sent to the model as delimited data, and the OpenClaw brief agent has no tools, so a hostile product page cannot make the agent run commands.
- All fetches allow http(s) only, refuse private, loopback and link-local addresses (re-checked on every redirect), and are capped at 25 MB. Image downloads must return an image content type.
- The experimental `product-video` skill gives an agent `exec`. Only use it on pages you trust.

## Status

- Works: Shopify product links, vision-guided briefs, four visual themes, MP4 render, single-turn OpenClaw path.
- Not yet: Amazon links (need a saved page), voiceover, music, the multi-step OpenClaw skill is unreliable.
- Copy is model-written from the product page and is not fact-checked.

## Layout

- `src/scrape.mjs` – product page to normalized product data
- `src/brief.mjs` – product data to creative brief (Cerebras or OpenClaw)
- `src/compose.mjs` – brief to HyperFrames composition
- `src/make.mjs` – command-line entry point
