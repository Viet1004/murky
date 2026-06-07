# Murky — Chrome Extension

> Mask elements on any website. Pick a repeating element (a product card, a video tile, a feed post) and Murky overlays a mask on it on every visit — so you decide, deliberately, whether to look underneath.

Murky is a Manifest V3 Chrome extension that fights impulse browsing by **covering tempting content with playful masks you have to actively peel away**. It started as a mask for e-commerce product images and now also masks whole sites on a schedule and renders creator-made mask collections from the [Murky marketplace](../murky-server).

This README covers the extension. For cross-repo architecture, glossary, and contributor guides, start at [`../murky-project/AGENTS.md`](../murky-project/AGENTS.md); extension internals live in [`CLAUDE.md`](CLAUDE.md).

## What it does

- **Mask product images** on e-commerce sites (Shopee adapter built in; a generic element picker works anywhere). An on-device scorer decides which items are worth masking based on your focus prompt.
- **Click-to-reveal masks.** Layered image stacks you peel one tap at a time, flash cards, and quotes — a small friction step before you see the product.
- **Red-list sites on a schedule.** Block/mask whole sites (e.g. `facebook.com`) during chosen hours; the overlay reuses your active mask collection's art.
- **Creator collections.** Sign in to acquire mask collections from the marketplace; paid collections unlock with credits, and unmasking spends them.
- **Regret nudges + behavior signals** (opt-in) to help you notice when you're bypassing your own guardrails.
- **Opt-in sync** of your settings to the server so the same setup follows you across devices.

## How it works

Three bundled entry points plus a few injected scripts:

- **`src/content.ts` → `dist/content.js`** — injected into pages; finds elements via site adapters, scores them, and mounts masks.
- **`src/background.ts` → `dist/background.js`** — service worker; proxies all server requests (content scripts can't reach `localhost` under Private Network Access), composes the red-list overlay, and handles click traces.
- **`src/popup.ts` → `dist/popup.js`** — toolbar popup: sign in, pick the active collection, manage the red list and settings.
- Injected helpers: **`picker`** (element picker), **`regret`** (post-click nudge), **`redlist`** (full-page scheduled overlay).

Key pieces:

- **Masks are server-compiled.** The server returns each mask as `render_html` + a `behavior` id; the extension mounts the HTML and activates the behavior from a small allowlist (`static`, `peel-stack`, `flip-card`) — see [`src/masks/`](src/masks). If no collection is active (or it's been fully consumed), it falls back to bundled local masks.
- **Scoring** uses an on-device embedding model ([`@xenova/transformers`](https://github.com/xenova/transformers.js)) so your browsing isn't sent anywhere to decide what to mask — see [`src/scoring/`](src/scoring).
- **Site adapters** ([`src/adapters/`](src/adapters)) define per-site element selectors; the generic picker handles everything else.
- **Networking** always goes through the background worker (`bgFetch`), never directly from content scripts.

## Build & run

```bash
npm install
npm run build       # bundle all entry points into dist/ (esbuild, IIFE/ES2020)
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
```

Load it in Chrome:

1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder (the one with `manifest.json`).
3. After each `npm run build`, click **Reload** on the Murky card to pick up new `dist/` output.

The popup's **Server** field overrides the backend URL (handy for pointing at a local [`murky-server`](../murky-server) or a tunnel during development).

## Project layout

```
src/
  content.ts        page masking entry point
  background.ts     service worker (server proxy, red-list, click traces)
  popup.ts          toolbar popup
  packs.ts          collection loading + reveal/credit calls
  auth.ts           Supabase auth token handling
  collector.ts      finds product cards on the page
  masks/            mask renderer + behavior allowlist
  adapters/         per-site element selectors (Shopee, …)
  scoring/          on-device relevance scorer
  redlist/          scheduled site blocking
  regret/           post-click reflection nudge
  picker/           click-to-pick element selector
  behavior/         opt-in behavioral signals
  sync/             opt-in settings sync to the server
dist/               build output (load this folder in Chrome)
manifest.json       MV3 manifest
```

## Related

- [`murky-server`](../murky-server) — FastAPI backend: masks, collections, marketplace, payments.
- [`../murky-project/docs`](../murky-project/docs) — project-wide docs (architecture, concepts, guides).

## Privacy

Scoring runs on-device. Server sync and behavioral signal collection are **opt-in** and disclosed in the popup; your masking source of truth is `chrome.storage.local`.
