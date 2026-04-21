# Behavior collection — teardown guide

Living document. Keep in sync as the prototype evolves: every time a new
file, table, column, setting key, or endpoint is added to the behavioral
data collection feature, list it here.

The goal: when we decide this toy version is done, anyone (future you,
future me) can wipe it in one session without touching the rest of Murky.

Last verified: 2026-04-21 (initial implementation).

---

## What this feature is

An opt-in behavioral data pipeline that ships impression/unmask/click
events from the Chrome extension to the FastAPI server, where a simple
rule engine writes a per-session `impulsivity_score`. All isolated from
the core masking feature — the extension works fine without it.

---

## Teardown checklist

### 1. murky-server

- [ ] Remove `behavior` from the imports in [app/main.py](../murky-server/app/main.py):
      `from .routers import admin, admin_v2, behavior, collections, ...`
- [ ] Remove the line `app.include_router(behavior.router)` in [app/main.py](../murky-server/app/main.py)
- [ ] Remove `"behavior"` from `reserved_paths` and `"behavior/"` from
      `reserved_prefixes` in the SPA-fallback handler in [app/main.py](../murky-server/app/main.py)
- [ ] Delete [app/routers/behavior.py](../murky-server/app/routers/behavior.py)
- [ ] Delete [app/services/behavior_service.py](../murky-server/app/services/behavior_service.py)
- [ ] Delete the migration file [sql/005_behavior.sql](../murky-server/sql/005_behavior.sql)
      (or keep it for history — not imported by anything)

### 2. Extension (murky)

- [ ] Delete the whole directory [src/behavior/](src/behavior/)
- [ ] In [src/content.ts](src/content.ts):
  - [ ] Remove the `import { initBehaviorCollector, recordBehavior... } from "./behavior";` block
  - [ ] Remove the `void initBehaviorCollector(adapter.siteId);` line
  - [ ] Remove every `recordBehaviorImpression(...)`, `recordBehaviorUnmask(...)`,
        `recordBehaviorRemask(...)`, `recordBehaviorClick(...)` call
- [ ] In [popup.html](popup.html): remove the `<div class="card" id="behaviorCard">...</div>`
      block (the "Collect behavioral data" toggle + clear-data button)
- [ ] In [src/popup.ts](src/popup.ts):
  - [ ] Remove the `behaviorToggle` and `clearBehaviorBtn` element refs
  - [ ] Remove `murkyBehaviorEnabled` from the initial `chrome.storage.local.get` call
  - [ ] Remove the two event listener blocks under `// ---------- Behavior collection toggle ----------`
- [ ] Rebuild: `npm run build`

### 3. Database (Supabase SQL Editor)

Run once to drop the tables:

```sql
drop table if exists public.beh_ratings      cascade;
drop table if exists public.beh_intents      cascade;
drop table if exists public.beh_interactions cascade;
drop table if exists public.beh_pages        cascade;
drop table if exists public.beh_sessions     cascade;
```

### 4. Clean up client-side storage (optional, per install)

Users who had the toggle on will have these keys in `chrome.storage.local`:

- `murkyBehaviorEnabled` (boolean)
- `murkyAnonId` (string)

They're harmless once the code is gone, but a one-shot cleanup snippet to
paste into the extension's DevTools console if desired:

```js
chrome.storage.local.remove(["murkyBehaviorEnabled", "murkyAnonId"]);
```

---

## Inventory of everything this feature touches

Keep this list complete. If a future PR adds an artifact related to
behavior collection, add it here in the same category. If a PR removes
one, strike it through.

### Files (source of truth)

**murky-server:**
- `sql/005_behavior.sql` — migration defining the `beh_*` tables
- `app/routers/behavior.py` — `/behavior/*` endpoints + Pydantic schemas
- `app/services/behavior_service.py` — ingestion + rule engine

**murky (extension):**
- `src/behavior/index.ts` — collector, batcher, bgFetch POST wrapper

### Modifications inside existing files

**murky-server:**
- `app/main.py` — added `behavior` import, `include_router(behavior.router)`, two reserved-path additions

**murky (extension):**
- `src/content.ts` — imports from `./behavior`, `initBehaviorCollector(...)` call, four `recordBehavior*` calls
- `popup.html` — new `#behaviorCard` block
- `src/popup.ts` — two new element refs, `murkyBehaviorEnabled` read, two new event listeners

### Database tables (all `beh_*` prefix)

- `public.beh_sessions`
- `public.beh_pages`
- `public.beh_interactions`
- `public.beh_intents`
- `public.beh_ratings`

No foreign keys point *into* these tables from anywhere else — safe to
drop with `CASCADE`.

### HTTP endpoints

- `POST /behavior/events`
- `POST /behavior/intents`
- `POST /behavior/ratings`
- `POST /behavior/clear`

### chrome.storage.local keys

- `murkyBehaviorEnabled` — opt-in flag, default off
- `murkyAnonId` — stable per-install anonymous ID, generated on first opt-in

### Dependencies added

- None. Pure Python + vanilla DOM.

---

## If we decide to keep parts of it

Some pieces may end up worth keeping even after this toy is retired:

- **The `anon_id` concept** for users who aren't signed in — may be
  reusable for future analytics
- **The rule DSL** (`RULE_WEIGHTS` in `behavior_service.py`) — the shape
  is probably right for a v2
- **The opt-in/clear-data UX** — the pattern is required for any future
  data collection; don't throw it out

If you keep any of the above, remove them from this teardown doc so the
checklist stays accurate.
