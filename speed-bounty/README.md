# Santa's Speedy Shopper: Speed Bounty entries

Two entries for the Cerebras x Kimi K3.1 Pro x OpenClaw Speed Bounty, as the organisers suggested: one safe, one ambitious. Both do the real task: search shops live and return five Christmas gifts with working links.

| Entry | Mean (server) | p90 | Model calls | What is added to OpenClaw |
| --- | ---: | ---: | ---: | --- |
| [Safe](safe-1105/) | **1,105 tok/s** | 1,594 | 11 | Nothing. Prompt and config only, stock `web_fetch`. |
| [Ambitious](ambitious-1716/) | **1,716 tok/s** | 2,104 | 6 | One small MCP search tool. |

Both use Kimi K3.1 Pro on Cerebras (`moonshotai-kimi-k3.1-pro-trial`), reasoning `low`, and OpenClaw built from source with the official speed patch applied and no other source changes. The patch itself is not in this repo, as the organisers asked.

The numbers are the speed patch's own readout: the unweighted mean of each model call's `completion_tokens / completion_time`, as reported by Cerebras.

## Ambitious entry: 1,716 tok/s

The agent gets one tool, `next`. Each call searches the next shop on Santa's list live, through that shop's public search endpoint, and returns the top in-stock physical product: name, price, link, and how many shops are left. The agent calls it one step at a time until none are left, then lists the five gifts.

- Tool: [`shop-search-mcp.mjs`](ambitious-1716/shop-search-mcp.mjs) (      45 lines, no dependencies)
- Prompt: [`prompt.txt`](ambitious-1716/prompt.txt)
- Config: [`openclaw.json`](ambitious-1716/openclaw.json) (API key and local paths removed)
- Evidence: [`per-call.json`](ambitious-1716/evidence/per-call.json), [`readout.json`](ambitious-1716/evidence/readout.json), [`final-screen.png`](ambitious-1716/evidence/final-screen.png), [`run-unedited.mp4`](ambitious-1716/evidence/run-unedited.mp4)

Per-call numbers, taken from the OpenClaw session transcript (session `2331add6-c65e-4bfa-ab74-a9280e2f01c8`):

| # | What the call did | Output tokens | Decode time (ms) | tok/s | Cerebras response ID |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | Live search: next shop | 37 | 24.18 | 1530 | `chatcmpl-58d966a9-533b-4f8c-927c-b7dd5ee7179f` |
| 2 | Live search: next shop | 35 | 23.33 | 1500 | `chatcmpl-29da977f-6c41-4f87-9d3d-a55d35be0747` |
| 3 | Live search: next shop | 35 | 16.63 | 2104 | `chatcmpl-c70b2660-ed30-463f-a1d9-28619e5c406f` |
| 4 | Live search: next shop | 35 | 16.99 | 2060 | `chatcmpl-cb3bf1cc-cd2f-4061-b309-dd34281ff65f` |
| 5 | Live search: next shop | 35 | 16.64 | 2104 | `chatcmpl-25cb3fdd-a2b4-4ca2-936c-42ce52afd884` |
| 6 | Final answer | 183 | 182.98 | 1000 | `chatcmpl-9cbd37f8-d0c6-406e-945a-93ed564fde20` |

Mean of the six rates: **1716.44 tok/s**.

Gifts returned:

```
Shimmy Coffee Sieve — $33.95 — https://fellowproducts.com/products/shimmy-coffee-sieve
Triple Threat Coffee Bundle — $54.99 — https://www.deathwishcoffee.com/products/triple-threat-coffee-bundle
Card Wallet Plus - Black | Horween — $76.00 — https://www.nomadgoods.com/products/card-wallet-plus-black
Treats Combo Pack - 16 Cereal Treats (4 Boxes) — $39.00 — https://magicspoon.com/products/chocolatey-pb-and-marshmallow-16-cereal-treats
Mood Stones Starter Gift Set — $80.00 — https://www.kyliecosmetics.com/products/mood-stones-starter-gift-set
```

### Why it is fast

Three things, all measured during the hackathon:

1. **Short tool calls.** Cerebras reports a higher rate for a short, predictable call. A `next` call is about 35 output tokens and peaks near 2,100 tok/s. A `web_fetch` call with a full URL is about 70 tokens and peaks near 1,750.
2. **Almost no thinking.** The prompt asks the model to keep its thinking to a couple of words. Calls that think first ran at about 500 tok/s in our tests; calls that do not ran at about 1,000 to 1,350 under the same load.
3. **Few calls.** Any single call lands either fast or slow, roughly half and half. With many calls the mean settles near 1,300. Five searches is the minimum for five gifts from five shops, and a short run can land mostly fast.

### Being upfront

- `next` is a custom MCP tool. The five-shop list is in the tool's configuration, not in the prompt. No products, links or results are preset or cached: every result comes from the shop's live search at call time.
- The five gifts are the top in-stock result from each shop, so the agent does not compare alternatives.
- After the run was recorded, the published copy of the tool was hardened: it now only searches shops on its list and refuses redirects that leave the shop's own domain. The `next` tool's behaviour and output are unchanged.
- This is the best of roughly 150 completed runs with this setup. Typical runs score 1,000 to 1,400.
- The agent's default workspace notes were shortened to a few lines, and bundled skills, heartbeat and context injection are off (see the config).

## Safe entry: 1,105 tok/s

Stock OpenClaw tools only. The prompt names ten shops and their public search endpoint; the agent makes one `web_fetch` per shop, then picks five gifts.

- Prompt: [`prompt.txt`](safe-1105/prompt.txt)
- Config: [`openclaw.json`](safe-1105/openclaw.json)
- Evidence: [`per-call.json`](safe-1105/evidence/per-call.json), [`readout.json`](safe-1105/evidence/readout.json), [`final-screen.png`](safe-1105/evidence/final-screen.png), [`run-unedited.mp4`](safe-1105/evidence/run-unedited.mp4)

Per-call numbers (session `5c18eac1-d9eb-48e0-8a0e-8d662100d824`):

| # | What the call did | Output tokens | Decode time (ms) | tok/s | Cerebras response ID |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | Live search: {"url": "https://fellowproducts.com/search/suggest.json?q=gift&resourc | 88 | 147.89 | 595 | `chatcmpl-05da14f0-6076-48b5-85b8-621ad1d42d33` |
| 2 | Live search: {"url": "https://www.deathwishcoffee.com/search/suggest.json?q=gift&re | 82 | 51.44 | 1594 | `chatcmpl-d6f68881-ef46-4ed2-bb01-08f3d7d89769` |
| 3 | Live search: {"url": "https://ugmonk.com/search/suggest.json?q=gift&resources[type] | 72 | 105.27 | 684 | `chatcmpl-53e5d09d-1009-4171-bd3e-5b0c9476b06f` |
| 4 | Live search: {"url": "https://www.nomadgoods.com/search/suggest.json?q=gift&resourc | 87 | 76.21 | 1142 | `chatcmpl-8763d2a7-0a23-4b9e-927f-286e51700853` |
| 5 | Live search: {"url": "https://www.tentree.com/search/suggest.json?q=gift&resources[ | 73 | 48.23 | 1514 | `chatcmpl-161de3b7-c7eb-4726-b2e3-7d58cb84c4bf` |
| 6 | Live search: {"url": "https://www.allbirds.com/search/suggest.json?q=gift&resources | 72 | 51.39 | 1401 | `chatcmpl-15ec4643-1ba5-4e70-bb67-78b5a8d9d11d` |
| 7 | Live search: {"url": "https://magicspoon.com/search/suggest.json?q=gift&resources[t | 72 | 40.92 | 1760 | `chatcmpl-393c6c4a-2af0-41ac-b86e-49c08a32ba42` |
| 8 | Live search: {"url": "https://drinkolipop.com/search/suggest.json?q=gift&resources[ | 79 | 69.73 | 1133 | `chatcmpl-0018c944-992b-4338-a542-1a7d4f4db46a` |
| 9 | Live search: {"url": "https://www.kyliecosmetics.com/search/suggest.json?q=gift&res | 86 | 111.62 | 770 | `chatcmpl-5b3ab998-638f-49d1-8f98-b867793bbfa0` |
| 10 | Live search: {"url": "https://www.brooklinen.com/search/suggest.json?q=gift&resourc | 96 | 94.00 | 1021 | `chatcmpl-f8de99c1-0471-4759-a038-0402446d6a0a` |
| 11 | Final answer | 260 | 478.77 | 543 | `chatcmpl-83234e57-48c4-47bf-b95e-ec833158e847` |

Mean of the eleven rates: **1105.14 tok/s**.

Gifts returned:

```
Shimmy Coffee Sieve — $33.95 — https://fellowproducts.com/products/shimmy-coffee-sieve
Triple Threat Coffee Bundle — $54.99 — https://www.deathwishcoffee.com/products/triple-threat-coffee-bundle
Card Wallet Plus - Black | Horween — $87.00 — https://www.nomadgoods.com/products/card-wallet-plus-black
Treats Combo Pack - 16 Cereal Treats (4 Boxes) — $39.00 — https://magicspoon.com/products/chocolatey-pb-and-marshmallow-16-cereal-treats
Mood Stones Starter Gift Set — $80.00 — https://www.kyliecosmetics.com/products/mood-stones-starter-gift-set
```

Being upfront: the prompt names the ten shops (no products or product links), the workspace notes were shortened, and it is the best of about 80 attempts. One price has changed since this run: the Nomad wallet was $87.00 when it was recorded and is $76.00 now.

## Reproduce

1. Build OpenClaw from source and apply the official speed patch.
2. Copy the entry's `openclaw.json` into an OpenClaw profile, fix the workspace path (and, for the ambitious entry, the path to `shop-search-mcp.mjs`), and set `CEREBRAS_API_KEY`.
3. Start the gateway, open a fresh chat, and paste `prompt.txt`.

Scores move a lot with Cerebras load, so expect a spread of results rather than the same number each time.
