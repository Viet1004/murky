/**
 * Cross-device sync subsystem (background-side only).
 *
 * Mental model = Model A: when sync is on, the user's account on the
 * server is the source of truth. The local chrome.storage cache is a
 * writable view onto that account. Local edits push up immediately and
 * the server's stored state propagates back via pull.
 *
 * On conflict (same origin in both places), server wins — *not* newer
 * timestamp. This is the difference from a peer-to-peer LWW model and
 * the reason the user can trust "delete on phone, gone on laptop."
 *
 * The first time sync is enabled, the popup shows an explicit dialog
 * asking the user how to reconcile any pre-existing local data with
 * whatever's on the server. That choice is one-shot and chooses between
 * three sync modes:
 *
 *   - "merge"   — additively combine local + server (server wins on
 *                 conflict). For users who say "add my device's data
 *                 to my account."
 *   - "replace" — wipe local, then pull from server. For users who say
 *                 "I want this device to look like my account."
 *   - "normal"  — ongoing sync, used after the first merge has happened.
 *                 Server is canonical: pull → server-only items pull
 *                 down, both-sides items take server's version,
 *                 local-only items are assumed to be unsynced new
 *                 entries and get pushed up. (Without tombstones, a
 *                 deletion on another device that hasn't propagated yet
 *                 may briefly resurrect locally; LWW handles convergence.)
 *
 * Lives entirely in the background service worker. The picker, content
 * script, and popup never call this module directly — they write to
 * chrome.storage as before. The background watches storage changes and
 * fires push/pull against the murky-server when:
 *   1. The user is signed in (murkyAuthToken is present), AND
 *   2. The sync toggle is on (murkySyncEnabled === true).
 *
 * Both conditions are checked on every operation, so flipping either
 * back to off stops all subsequent network activity immediately.
 *
 * Server-side contract: see app/routers/me.py
 *   GET    /me/site-selectors
 *   PUT    /me/site-selectors
 *   DELETE /me/site-selectors?origin=...
 *   GET    /me/preferences
 *   PUT    /me/preferences
 */

import { SiteSelectorConfig } from "../picker/store";

const SYNC_ENABLED_KEY = "murkySyncEnabled";
const AUTH_TOKEN_KEY = "murkyAuthToken";
const SERVER_URL_KEY = "murkyServerUrl";
const SITE_SELECTORS_KEY = "murkySiteSelectors";
const PROFILE_KEY = "murkyProfile";
const SCORER_ID_KEY = "murkyScorerId";
const PREFS_UPDATED_AT_KEY = "murkyPreferencesUpdatedAt";
const DEFAULT_SERVER_URL = "https://gum2fjwx5t.ap-southeast-1.awsapprunner.com";

interface UserProfile {
  prompt?: string;
}

interface ServerSiteSelector {
  origin: string;
  card_selector: string;
  href_selector: string | null;
  image_selector: string | null;
  title_selector: string | null;
  price_selector: string | null;
  label: string | null;
  saved_at: string | null;
  updated_at: string | null;
}

interface ServerPreferences {
  focus_prompt: string | null;
  scorer_id: string | null;
  updated_at: string | null;
}

// ---- Helpers --------------------------------------------------------

function storageGet<T extends object>(keys: string[]): Promise<T> {
  return new Promise((resolve) =>
    chrome.storage.local.get(keys, (r) => resolve(r as T))
  );
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set(items, () => resolve()));
}

async function serverUrl(): Promise<string> {
  const r = await storageGet<{ [SERVER_URL_KEY]?: string }>([SERVER_URL_KEY]);
  return (r[SERVER_URL_KEY] ?? DEFAULT_SERVER_URL).replace(/\/$/, "");
}

async function authHeader(): Promise<Record<string, string> | null> {
  const r = await storageGet<{ [AUTH_TOKEN_KEY]?: string }>([AUTH_TOKEN_KEY]);
  const token = r[AUTH_TOKEN_KEY];
  return token ? { Authorization: `Bearer ${token}` } : null;
}

export async function isSyncEnabled(): Promise<boolean> {
  const r = await storageGet<{
    [SYNC_ENABLED_KEY]?: boolean;
    [AUTH_TOKEN_KEY]?: string;
  }>([SYNC_ENABLED_KEY, AUTH_TOKEN_KEY]);
  return r[SYNC_ENABLED_KEY] === true && Boolean(r[AUTH_TOKEN_KEY]);
}

function isoFromMs(ms: number | undefined): string {
  return new Date(ms ?? Date.now()).toISOString();
}

function msFromIso(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

// ---- Site selector push / delete ------------------------------------

export async function pushSiteSelector(config: SiteSelectorConfig): Promise<void> {
  if (!(await isSyncEnabled())) return;
  const headers = await authHeader();
  if (!headers) return;
  try {
    const res = await fetch(`${await serverUrl()}/me/site-selectors`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: config.origin,
        card_selector: config.cardSelector,
        href_selector: config.hrefSelector ?? null,
        image_selector: config.imageSelector ?? null,
        title_selector: config.titleSelector ?? null,
        price_selector: config.priceSelector ?? null,
        label: config.label ?? null,
      }),
    });
    console.info(
      `[murky sync] PUT /me/site-selectors ${config.origin} — HTTP ${res.status}`
    );
  } catch (e) {
    console.warn("[murky sync] push site selector failed", e);
  }
}

export async function deleteSiteSelectorOnServer(origin: string): Promise<void> {
  if (!(await isSyncEnabled())) return;
  const headers = await authHeader();
  if (!headers) return;
  try {
    const url = new URL(`${await serverUrl()}/me/site-selectors`);
    url.searchParams.set("origin", origin);
    const res = await fetch(url.toString(), { method: "DELETE", headers });
    console.info(
      `[murky sync] DELETE /me/site-selectors ${origin} — HTTP ${res.status}`
    );
  } catch (e) {
    console.warn("[murky sync] delete site selector failed", e);
  }
}

// ---- Preferences push -----------------------------------------------

export async function pushPreferences(): Promise<void> {
  if (!(await isSyncEnabled())) return;
  const headers = await authHeader();
  if (!headers) return;
  const r = await storageGet<{
    [PROFILE_KEY]?: UserProfile;
    [SCORER_ID_KEY]?: string;
  }>([PROFILE_KEY, SCORER_ID_KEY]);
  const focusPrompt = r[PROFILE_KEY]?.prompt ?? null;
  const scorerId = r[SCORER_ID_KEY] ?? null;
  try {
    const res = await fetch(`${await serverUrl()}/me/preferences`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ focus_prompt: focusPrompt, scorer_id: scorerId }),
    });
    await storageSet({ [PREFS_UPDATED_AT_KEY]: Date.now() });
    console.info(
      `[murky sync] PUT /me/preferences — HTTP ${res.status} ` +
      `(focus_prompt=${focusPrompt ? "set" : "null"}, scorer_id=${scorerId ?? "null"})`
    );
  } catch (e) {
    console.warn("[murky sync] push preferences failed", e);
  }
}

// ---- Run-sync (server-canonical, with three modes) -----------------

/**
 * Sync mode determines how the local cache reconciles with the server.
 *
 * - "merge"   First-time enable, "Add this device's data to my account":
 *             server-only items pull down, local-only items push up,
 *             both-sides items take the SERVER's version (server is now
 *             becoming the canonical store).
 * - "replace" First-time enable, "Replace this device with my account":
 *             wipe local, then pull from server. Local edits made before
 *             enabling sync are discarded — the user explicitly chose
 *             "give me the cloud version."
 * - "normal"  Ongoing sync after the first-time merge has happened.
 *             Server is canonical: pull drives the local cache. The
 *             local-only case is treated as "newly created, push it"
 *             since we can't (yet) distinguish "new" from "deleted on
 *             another device."
 */
export type SyncMode = "merge" | "replace" | "normal";

export async function runSync(mode: SyncMode = "normal"): Promise<void> {
  if (!(await isSyncEnabled())) {
    console.debug("[murky sync] runSync skipped — sync disabled or signed out");
    return;
  }
  const headers = await authHeader();
  if (!headers) return;

  if (mode === "replace") {
    await replaceLocalWithServer(headers);
    return;
  }

  await reconcileSelectors(headers, mode);
  await reconcilePreferences(headers, mode);
}

/** Back-compat: the SW startup hook still calls pullAndMerge(). */
export async function pullAndMerge(): Promise<void> {
  return runSync("normal");
}

// --- Selectors -------------------------------------------------------

async function reconcileSelectors(
  headers: Record<string, string>,
  mode: "merge" | "normal"
): Promise<void> {
  let serverSelectors: ServerSiteSelector[] = [];
  try {
    const res = await fetch(`${await serverUrl()}/me/site-selectors`, { headers });
    if (res.ok) serverSelectors = (await res.json()) as ServerSiteSelector[];
    else {
      console.warn("[murky sync] pull site-selectors HTTP", res.status);
      return;
    }
  } catch (e) {
    console.debug("[murky sync] pull site-selectors failed", e);
    return;
  }

  const local = await storageGet<{
    [SITE_SELECTORS_KEY]?: Record<string, SiteSelectorConfig>;
  }>([SITE_SELECTORS_KEY]);
  const localStore: Record<string, SiteSelectorConfig> =
    local[SITE_SELECTORS_KEY] ?? {};

  const serverByOrigin = new Map(serverSelectors.map((s) => [s.origin, s]));
  const localOrigins = new Set(Object.keys(localStore));
  const serverOrigins = new Set(serverByOrigin.keys());
  let pulled = 0;
  let pushed = 0;

  // Server-side wins on conflict (Model A). The mode only changes how
  // we handle local-only items.
  for (const origin of serverOrigins) {
    const s = serverByOrigin.get(origin)!;
    localStore[origin] = serverToLocalSelector(s);
    if (!localOrigins.has(origin)) pulled++;
  }
  for (const origin of localOrigins) {
    if (!serverOrigins.has(origin)) {
      // Local-only: push up. In both "merge" and "normal" we treat this
      // as "the user created it locally and we owe it to the server."
      // Without tombstones we can't distinguish this from "another
      // device deleted it" — LWW handles eventual convergence.
      await pushSiteSelector(localStore[origin]);
      pushed++;
    }
  }
  await storageSet({ [SITE_SELECTORS_KEY]: localStore });
  console.info(
    `[murky sync] selectors reconciled (mode=${mode}) — pulled ${pulled}, pushed ${pushed}, ` +
    `local=${localOrigins.size}, server=${serverOrigins.size}`
  );
}

// --- Preferences -----------------------------------------------------

async function reconcilePreferences(
  headers: Record<string, string>,
  mode: "merge" | "normal"
): Promise<void> {
  let serverPrefs: ServerPreferences | null = null;
  try {
    const res = await fetch(`${await serverUrl()}/me/preferences`, { headers });
    if (res.ok) serverPrefs = (await res.json()) as ServerPreferences;
  } catch (e) {
    console.debug("[murky sync] pull preferences failed", e);
    return;
  }
  if (!serverPrefs) return;

  const localPrefs = await storageGet<{
    [PROFILE_KEY]?: UserProfile;
    [SCORER_ID_KEY]?: string;
    [PREFS_UPDATED_AT_KEY]?: number;
  }>([PROFILE_KEY, SCORER_ID_KEY, PREFS_UPDATED_AT_KEY]);
  const serverHasPrefs =
    serverPrefs.focus_prompt !== null || serverPrefs.scorer_id !== null;
  const localHasValues = Boolean(
    localPrefs[PROFILE_KEY]?.prompt || localPrefs[SCORER_ID_KEY]
  );

  // Model A: server wins. The only time local "wins" is when the server
  // has no preferences row yet AND local has values to seed it with.
  if (serverHasPrefs) {
    const profile: UserProfile = { ...(localPrefs[PROFILE_KEY] ?? {}) };
    if (serverPrefs.focus_prompt !== null) profile.prompt = serverPrefs.focus_prompt;
    else delete profile.prompt;
    const next: Record<string, unknown> = {
      [PROFILE_KEY]: profile,
      [PREFS_UPDATED_AT_KEY]: msFromIso(serverPrefs.updated_at) || Date.now(),
    };
    if (serverPrefs.scorer_id !== null) next[SCORER_ID_KEY] = serverPrefs.scorer_id;
    await storageSet(next);
    console.info(`[murky sync] preferences pulled from server (mode=${mode})`);
  } else if (localHasValues) {
    await pushPreferences();
    console.info(`[murky sync] preferences seeded to server (mode=${mode})`);
  }
}

// --- Replace ---------------------------------------------------------

async function replaceLocalWithServer(
  headers: Record<string, string>
): Promise<void> {
  // 1. Clear local selectors and preferences.
  await storageSet({
    [SITE_SELECTORS_KEY]: {},
    [PROFILE_KEY]: {},
    [PREFS_UPDATED_AT_KEY]: 0,
  });
  // SCORER_ID_KEY: leave the popup's view untouched if server doesn't
  // override it below.

  // 2. Pull server selectors.
  let serverSelectors: ServerSiteSelector[] = [];
  try {
    const res = await fetch(`${await serverUrl()}/me/site-selectors`, { headers });
    if (res.ok) serverSelectors = (await res.json()) as ServerSiteSelector[];
  } catch (e) {
    console.debug("[murky sync] replace: pull selectors failed", e);
  }
  const localStore: Record<string, SiteSelectorConfig> = {};
  for (const s of serverSelectors) {
    localStore[s.origin] = serverToLocalSelector(s);
  }
  await storageSet({ [SITE_SELECTORS_KEY]: localStore });
  console.info(
    `[murky sync] replace: pulled ${serverSelectors.length} selectors from server`
  );

  // 3. Pull server preferences.
  try {
    const res = await fetch(`${await serverUrl()}/me/preferences`, { headers });
    if (res.ok) {
      const serverPrefs = (await res.json()) as ServerPreferences;
      const profile: UserProfile = {};
      if (serverPrefs.focus_prompt !== null) profile.prompt = serverPrefs.focus_prompt;
      const next: Record<string, unknown> = {
        [PROFILE_KEY]: profile,
        [PREFS_UPDATED_AT_KEY]: msFromIso(serverPrefs.updated_at) || Date.now(),
      };
      if (serverPrefs.scorer_id !== null) next[SCORER_ID_KEY] = serverPrefs.scorer_id;
      await storageSet(next);
      console.info("[murky sync] replace: pulled preferences from server");
    }
  } catch (e) {
    console.debug("[murky sync] replace: pull prefs failed", e);
  }
}

function serverToLocalSelector(s: ServerSiteSelector): SiteSelectorConfig {
  return {
    origin: s.origin,
    cardSelector: s.card_selector,
    hrefSelector: s.href_selector ?? undefined,
    imageSelector: s.image_selector ?? undefined,
    titleSelector: s.title_selector ?? undefined,
    priceSelector: s.price_selector ?? undefined,
    label: s.label ?? undefined,
    savedAt: msFromIso(s.updated_at) || msFromIso(s.saved_at) || Date.now(),
  };
}

// ---- Clear all on server (for the popup's "Delete sync data" button) ----

export async function clearAllOnServer(): Promise<void> {
  const headers = await authHeader();
  if (!headers) return;
  // Pull current selectors so we know what to delete.
  let serverSelectors: ServerSiteSelector[] = [];
  try {
    const res = await fetch(`${await serverUrl()}/me/site-selectors`, { headers });
    if (res.ok) serverSelectors = (await res.json()) as ServerSiteSelector[];
  } catch (e) {
    console.debug("[murky sync] clear: pull failed", e);
    return;
  }
  for (const s of serverSelectors) {
    try {
      const url = new URL(`${await serverUrl()}/me/site-selectors`);
      url.searchParams.set("origin", s.origin);
      await fetch(url.toString(), { method: "DELETE", headers });
    } catch (e) {
      console.debug("[murky sync] clear: delete failed", s.origin, e);
    }
  }
  // Wipe preferences by sending nulls.
  try {
    await fetch(`${await serverUrl()}/me/preferences`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ focus_prompt: null, scorer_id: null }),
    });
  } catch (e) {
    console.debug("[murky sync] clear: prefs failed", e);
  }
}

// ---- Storage-change watcher (preferences only) ----------------------

export function watchStorageForPreferenceChanges(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[PROFILE_KEY] || changes[SCORER_ID_KEY]) {
      // Bump the local timestamp first so pull/push uses the right one.
      void storageSet({ [PREFS_UPDATED_AT_KEY]: Date.now() }).then(() =>
        pushPreferences()
      );
    }
  });
}
