# Recibox

A personal recipe box: save recipes from links, pasted captions (Instagram / TikTok / YouTube) or by hand. Free forever — no account, no backend, no subscription. It's a static PWA, so GitHub Pages hosts it for $0 and recipes are stored on your device.

## Features (MVP)

- **Import from a link** – reads the structured recipe data (schema.org JSON-LD) that almost every recipe site publishes; falls back to heuristics on the page text.
- **Import from a caption** – paste an Instagram/TikTok/YouTube caption or any recipe text; Ingredients / Instructions sections, bullets, numbering and `#hashtags` (→ tags) are detected. You always get a review/edit screen before saving.
- **Import from a PDF** – recipe cards, cookbook pages, or any site saved via *Print → Save as PDF* (handy for paywalled sites). Text is extracted on-device with a bundled copy of pdf.js; scanned/photo PDFs need OCR, which isn't included yet.
- **Browser bookmarklet** (desktop) – one click on any page, including an open Instagram post, sends the recipe or caption to Recibox.
- **Android share target** – install the PWA, then *Share → Recibox* from any app.
- **Library** – search (title, ingredients, tags, notes), tags, favorites.
- **Servings scaler** – scales quantities (`1 1/2`, `½`, `2-3`, …).
- **Cook mode** – big one-step-at-a-time view, screen stays awake.
- **Grocery list** – add a recipe's (scaled) ingredients, check off, copy.
- **Backup / restore** – export and import JSON.
- **Offline**, dark mode, installable.

## Deploy (GitHub Pages)

Settings → Pages → Source: **GitHub Actions** (the workflow in `.github/workflows/pages.yml` does the rest on every push to `main`).
Open `https://<your-user>.github.io/<repo>/` and install it (Android: Chrome menu → Install app; iPhone: Share → Add to Home Screen).

## How link import works (and its limits)

Browsers can't read arbitrary websites directly (CORS), so import goes through a CORS proxy. Defaults are public ones (`corsproxy.io`, `allorigins`); you can change them in **Settings**, and `worker/cors-proxy.js` is a ~25-line Cloudflare Worker you can deploy free to have your own.
Be aware the proxy sees the URLs you import.

- Recipe blogs: reliable.
- Instagram / TikTok: they block scrapers, so the link import usually can't see the caption. Use **Paste text** (copy the caption), the bookmarklet, or the Android share sheet → falls back to the paste screen automatically.
- Images are hotlinked, not copied (saves space; an image can disappear if the source deletes it, which Instagram CDN links do after a while — paste a stable image URL when it matters).

## Data

Everything is in your browser's IndexedDB (recipes) and localStorage (grocery list, settings). **No sync between devices yet** — use Export/Import JSON. Clearing site data deletes recipes, so back up now and then.

## Develop

No build step. Serve the folder with any static server, e.g. `npx serve .`

```bash
node --test tests/lib.test.js   # parser/scaling unit tests
node tests/e2e.js               # Playwright end-to-end (mocks the proxy)
```

## Ideas for next versions

- Sync via a private GitHub Gist or a Cloudflare KV/D1 worker
- Meal planner calendar
- Optional AI extraction from video transcripts using your own API key
- Copy images into IndexedDB for true offline / permanence
- Merge duplicate grocery items by ingredient+unit
