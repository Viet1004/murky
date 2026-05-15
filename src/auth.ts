/**
 * Shared auth helpers for the background SW and the sync subsystem.
 *
 * Lives in its own module so both `background.ts` (top-level entry point)
 * and `sync/index.ts` (imported by background.ts) can call into the same
 * token-refresh logic without introducing a circular import.
 *
 * The token-refresh contract:
 *   - getValidAccessToken() returns a JWT that is guaranteed to be valid
 *     for at least 60 seconds, refreshing via the Supabase auth endpoint
 *     if needed.
 *   - If refresh fails (network error, invalid refresh token, etc.) it
 *     returns null. Callers must treat null as "user is signed out."
 */

export const AUTH_TOKEN_KEY = "murkyAuthToken";
export const AUTH_EMAIL_KEY = "murkyAuthEmail";
export const AUTH_REFRESH_TOKEN_KEY = "murkyAuthRefreshToken";
export const AUTH_EXPIRES_AT_KEY = "murkyAuthExpiresAt";
const SERVER_URL_KEY = "murkyServerUrl";
const DEFAULT_SERVER_URL = "http://localhost:5173";

interface StoredAuth {
  [AUTH_TOKEN_KEY]?: string;
  [AUTH_REFRESH_TOKEN_KEY]?: string;
  [AUTH_EXPIRES_AT_KEY]?: number;
}

interface RefreshTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface PublicConfig {
  supabaseUrl: string;
  publishableKey: string;
}

let publicConfigPromise: Promise<PublicConfig> | null = null;

// --- Storage primitives (kept inline so this module has no other deps) ---

function storageGet<T extends object>(keys: string[]): Promise<T> {
  return new Promise((resolve) =>
    chrome.storage.local.get(keys, (r) => resolve(r as T))
  );
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set(items, () => resolve()));
}

function storageRemove(keys: string[]): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.remove(keys, () => resolve()));
}

export async function getServerUrl(): Promise<string> {
  const result = await storageGet<{ [SERVER_URL_KEY]?: string }>([SERVER_URL_KEY]);
  return (result[SERVER_URL_KEY] ?? DEFAULT_SERVER_URL).replace(/\/$/, "");
}

// --- Public Supabase config (URL + publishable key) ---------------------

function readPublicConfig(data: Record<string, unknown>): PublicConfig {
  const supabaseUrl =
    typeof data.supabaseUrl === "string"
      ? data.supabaseUrl
      : typeof data.supabase_url === "string"
        ? data.supabase_url
        : "";
  const publishableKey =
    typeof data.publishableKey === "string"
      ? data.publishableKey
      : typeof data.publishable_key === "string"
        ? data.publishable_key
        : typeof data.supabasePublishableKey === "string"
          ? data.supabasePublishableKey
          : typeof data.supabase_publishable_key === "string"
            ? data.supabase_publishable_key
            : typeof data.anonKey === "string"
              ? data.anonKey
              : typeof data.supabaseAnonKey === "string"
                ? data.supabaseAnonKey
                : "";
  if (!supabaseUrl || !publishableKey) {
    throw new Error("public config missing Supabase settings");
  }
  return { supabaseUrl: supabaseUrl.replace(/\/$/, ""), publishableKey };
}

export async function getPublicConfig(): Promise<PublicConfig> {
  if (!publicConfigPromise) {
    publicConfigPromise = getServerUrl()
      .then((serverUrl) => fetch(`${serverUrl}/api/public-config`))
      .then(async (res) => {
        if (!res.ok) throw new Error(`public config HTTP ${res.status}`);
        const data = (await res.json()) as Record<string, unknown>;
        return readPublicConfig(data);
      })
      .catch((err) => {
        publicConfigPromise = null;
        throw err;
      });
  }
  return publicConfigPromise;
}

// --- Auth state -------------------------------------------------------

export async function clearAuth(): Promise<void> {
  await storageRemove([
    AUTH_TOKEN_KEY,
    AUTH_EMAIL_KEY,
    AUTH_REFRESH_TOKEN_KEY,
    AUTH_EXPIRES_AT_KEY,
  ]);
}

/**
 * Returns a JWT that's valid for at least 60 s, refreshing it from the
 * Supabase auth endpoint if needed. Returns null when the user is signed
 * out (no token) or the refresh fails (expired refresh token).
 *
 * Used by both the foreground bgFetch path AND the background sync
 * subsystem so both keep the same valid-window invariant.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const auth = await storageGet<StoredAuth>([
    AUTH_TOKEN_KEY,
    AUTH_REFRESH_TOKEN_KEY,
    AUTH_EXPIRES_AT_KEY,
  ]);
  const token = auth[AUTH_TOKEN_KEY];
  const refreshToken = auth[AUTH_REFRESH_TOKEN_KEY];
  const expiresAt = auth[AUTH_EXPIRES_AT_KEY];
  if (!token) return null;
  if (typeof expiresAt === "number" && expiresAt - Date.now() > 60_000) return token;
  if (!refreshToken) return null;
  try {
    const { supabaseUrl, publishableKey } = await getPublicConfig();
    const res = await fetch(
      `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: { apikey: publishableKey, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }
    );
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) await clearAuth();
      return null;
    }
    const data = (await res.json()) as RefreshTokenResponse;
    if (
      typeof data.access_token !== "string" ||
      typeof data.refresh_token !== "string" ||
      typeof data.expires_in !== "number"
    ) {
      return null;
    }
    const newExpiresAt = Date.now() + data.expires_in * 1000;
    await storageSet({
      [AUTH_TOKEN_KEY]: data.access_token,
      [AUTH_REFRESH_TOKEN_KEY]: data.refresh_token,
      [AUTH_EXPIRES_AT_KEY]: newExpiresAt,
    });
    return data.access_token;
  } catch (err) {
    console.warn("[murky auth] failed to refresh auth token", err);
    return null;
  }
}
