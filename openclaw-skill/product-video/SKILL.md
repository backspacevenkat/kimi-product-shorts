---
name: product-video
description: Turn a product page URL (Shopify or any store) into a 15-second vertical product video. Use whenever the user sends a product link and wants a video, ad, short or reel.
---

# Product video

You are the creative director. Scripts do the scraping and rendering; you write the brief.

## Steps

1. Scrape (no model call, about one second):
   `node $PRODUCT_SHORTS_ROOT/src/make.mjs "<url>" --scrape-only`
   It prints JSON with `dir`, the local `images` paths and the `product` facts.
2. Look at the first two or three images with your image tool so the colours and hero shot fit the product.
3. Write `<dir>/brief.json` with exactly this shape:
   ```json
   {
     "theme": "pop | noir | editorial | neon",
     "palette": { "bg": "#rrggbb", "accent": "#rrggbb" },
     "hook": "2-5 words, the scroll-stopper, no product name, no period",
     "name": "short product name, max 4 words",
     "tagline": "max 7 words, concrete benefit",
     "features": [ { "title": "max 3 words", "line": "max 9 words" }, {}, {} ],
     "cta": "2-3 words",
     "heroImage": 0,
     "featureImages": [1, 2, 3]
   }
   ```
4. Build and render: `node $PRODUCT_SHORTS_ROOT/src/make.mjs --build "<dir>"`
5. Reply with the path of `video.mp4` and the hook you wrote. Nothing else.

## Rules for the brief

- Use only facts from the product data. Never invent ratings, reviews, awards, discounts or claims.
- Write like a human copywriter: specific and punchy. No cliches, emojis or hashtags.
- theme: pop = bright playful colour blocks (food, kids, fun gadgets); noir = dark premium (tech, coffee, menswear); editorial = warm off-white magazine look (fashion, home, beauty); neon = dark with electric glow (gaming, energy, fitness).
- palette.bg fits the theme; palette.accent is one bold contrasting colour drawn from the product. They must differ clearly.
- heroImage is the cleanest full-product shot. featureImages are three other indices.
- Do the steps in order without asking questions. Do not edit any other files.
