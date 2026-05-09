/**
 * Cross-device sync subsystem (background-side only).
 *
 * Lives entirely in the background service worker. The picker, content
 * script, and popup never call this module directly — they write to
 * chrome.storage as before. The background watches storage changes and
 * fires push/pull/merge against the murky-server when:
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
const DEFAULT_SERVER_URL = "http://localhost:5173";

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
    await fetch(`${await serverUrl()}/me/site-selectors`, {
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
  } catch (e) {
    console.debug("[murky sync] push site selector failed", e);
  }
}

export async function deleteSiteSelectorOnServer(origin: string): Promise<void> {
  if (!(await isSyncEnabled())) return;
  const headers = await authHeader();
  if (!headers) return;
  try {
    const url = new URL(`${await serverUrl()}/me/site-selectors`);
    url.searchParams.set("origin", origin);
    await fetch(url.toString(), { method: "DELETE", headers });
  } catch (e) {
    console.debug("[murky sync] delete site selector failed", e);
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
    await fetch(`${await serverUrl()}/me/preferences`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ focus_prompt: focusPrompt, scorer_id: scorerId }),
    });
    await storageSet({ [PREFS_UPDATED_AT_KEY]: Date.now() });
  } catch (e) {
    console.debug("[murky sync] push preferences failed", e);
  }
}

// ---- Pull + merge ---------------------------------------------------

/**
 * Pull from server and merge into local. Last-write-wins per origin
 * for selectors (compare server.updated_at vs local.savedAt). For
 * preferences, compare server.updated_at vs local PREFS_UPDATED_AT_KEY.
 *
 * Local-only entries are pushed up; server-only entries are pulled
 * down. After this completes, both sides agree.
 */
export async function pullAndMerge(): Promise<void> {
  if (!(await isSyncEnabled())) return;
  const headers = await authHeader();
  if (!headers) return;

  // --- Site selectors ---
  let serverSelectors: ServerSiteSelector[] = [];
  try {
    const res = await fetch(`${await serverUrl()}/me/site-selectors`, { headers });
    if (res.ok) serverSelectors = (await res.json()) as ServerSiteSelector[];
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

  // 1. Server-only -> pull into local.
  for (const origin of serverOrigins) {
    if (!localOrigins.has(origin)) {
      const s = serverByOrigin.get(origin)!;
      localStore[origin] = serverToLocalSelector(s);
    } else {
      // 2. Both sides — compare timestamps, keep newer.
      const localCfg = localStore[origin];
      const serverMs = msFromIso(serverByOrigin.get(origin)!.updated_at);
      const localMs = localCfg.savedAt;
      if (serverMs > localMs) {
        localStore[origin] = serverToLocalSelector(serverByOrigin.get(origin)!);
      } else if (localMs > serverMs) {
        await pushSiteSelector(localCfg);
      }
    }
  }
  // 3. Local-only -> push up.
  for (const origin of localOrigins) {
    if (!serverOrigins.has(origin)) {
      await pushSiteSelector(localStore[origin]);
    }
  }
  await storageSet({ [SITE_SELECTORS_KEY]: localStore });

  // --- Preferences ---
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
  const serverMs = msFromIso(serverPrefs.updated_at);
  const localMs = localPrefs[PREFS_UPDATED_AT_KEY] ?? 0;

  if (serverMs > localMs) {
    // Server wins: write into local. Don't bump local timestamp past
    // server's so the next push doesn't bounce it back.
    const profile: UserProfile = { ...(localPrefs[PROFILE_KEY] ?? {}) };
    if (serverPrefs.focus_prompt !== null) profile.prompt = serverPrefs.focus_prompt;
    else delete profile.prompt;
    const next: Record<string, unknown> = {
      [PROFILE_KEY]: profile,
      [PREFS_UPDATED_AT_KEY]: serverMs,
    };
    if (serverPrefs.scorer_id !== null) next[SCORER_ID_KEY] = serverPrefs.scorer_id;
    await storageSet(next);
  } else if (localMs > serverMs) {
    await pushPreferences();
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
