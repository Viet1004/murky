# Murky — Chrome Extension

Chrome Manifest V3 extension that masks product images on e-commerce sites with layered image overlays. Users click through layers to reveal the product underneath.

## Build & Dev

```bash
npm run build          # Build all entry points (content, popup, background)
npm run watch          # Watch mode for all three
npm run typecheck      # TypeScript check (no emit)
```

Entry points are bundled with esbuild (IIFE, ES2020):
- `src/content.ts` → `dist/content.js` — injected into pages, finds product images, applies masks
- `src/popup.ts` → `dist/popup.js` — extension popup for collection selection
- `src/background.ts` → `dist/background.js` — service worker that proxies fetch requests

After building, reload the extension in `chrome://extensions`.

## Architecture

### Content script ↔ Background worker

Content scripts run in the page's network context. Chrome's Private Network Access (PNA) policy blocks content scripts from fetching `localhost`. All network requests to the murky-server go through the background service worker via `chrome.runtime.sendMessage`. Never fetch the server directly from content scripts.

### Mask system

Masks are typed (`image-stack`, future: `math-equation`, `quiz`, etc.). Each mask type extends `BaseMask` in `src/masks/`. The registry maps mask type strings to factory instances.

- `src/masks/baseMask.ts` — abstract base with `mount()`, `reveal()`, overlay/caption rendering
- `src/masks/imageStackMask.ts` — N-layer image stack, click to peel top-to-bottom
- `src/masks/registry.ts` — factory registry, `register()` + `random()`

### Data flow

1. `content.ts` calls `loadActiveCollection()` from `src/packs.ts`
2. `packs.ts` sends fetch request via background worker → murky-server `/collections/{slug}`
3. Response contains masks with layers; `buildRegistry()` creates mask factories
4. `collector.ts` finds product images on the page via site adapters
5. Each image gets a random mask from the registry

### Site adapters

`src/adapters/` — one file per e-commerce site. Each adapter implements image selectors for that site. Currently: Shopee.

## Conventions

- TypeScript strict mode
- No direct `fetch()` to server from content scripts — always use `bgFetch()` via background worker
- `chrome.storage.local` for persisting settings (active collection slug, server URL)
- Mask images use `object-fit: contain` with `background-color: #ffffff` to fully cover layers behind
