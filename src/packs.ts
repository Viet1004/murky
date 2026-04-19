/**
 * Collection loading from the murky-server.
 *
 * Fetches collections (which contain masks with typed layers) from the
 * server and provides them to the content script for rendering.
 * Falls back to bundled local icons if unreachable or no collection selected.
 */

// ---------- Server response types ----------

export interface LayerInfo {
  id: string;
  url: string;
  position: number;
}

export interface ServerMask {
  id: string;
  type: string; // "image-stack", future: "math-equation", etc.
  display_name: string;
  description: string | null;
  config: Record<string, unknown>;
  layers: LayerInfo[];
}

export interface CollectionDetail {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  masks: ServerMask[];
}

export interface CollectionSummary {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  theme_count: number;
}

export interface LicenseInfo {
  id: string;
  collection_id: string;
  collection_slug: string;
  collection_name: string;
  granted_at: string;
  source: string;
}

// Legacy types for /packs endpoint (backward compat)
export interface PackSummary {
  slug: string;
  display_name: string;
  description: string | null;
  asset_count: number;
}

// ---------- Storage keys ----------

const DEFAULT_SERVER_URL = "http://localhost:8000";
const CACHE_KEY = "murkyCollectionCache";
const SERVER_URL_KEY = "murkyServerUrl";
const ACTIVE_PACK_KEY = "murkyActivePack"; // kept same key for compat
const AUTH_TOKEN_KEY = "murkyAuthToken";
const AUTH_EMAIL_KEY = "murkyAuthEmail";
const SUPABASE_URL_KEY = "murkySupabaseUrl";

interface CacheEntry {
  collection: CollectionDetail;
  fetchedAt: number;
}

// ---------- Helpers ----------

export async function getServerUrl(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get([SERVER_URL_KEY], (result) => {
      const url = (result[SERVER_URL_KEY] as string | undefined) ?? DEFAULT_SERVER_URL;
      resolve(url.replace(/\/$/, ""));
    });
  });
}

export async function getActiveSlug(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([ACTIVE_PACK_KEY], (result) => {
      resolve((result[ACTIVE_PACK_KEY] as string | undefined) ?? null);
    });
  });
}

export async function getAuthToken(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([AUTH_TOKEN_KEY], (result) => {
      resolve((result[AUTH_TOKEN_KEY] as string | undefined) ?? null);
    });
  });
}

export async function getAuthEmail(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([AUTH_EMAIL_KEY], (result) => {
      resolve((result[AUTH_EMAIL_KEY] as string | undefined) ?? null);
    });
  });
}

export async function setAuthToken(token: string | null): Promise<void> {
  return new Promise((resolve) => {
    if (token) {
      chrome.storage.local.set({ [AUTH_TOKEN_KEY]: token }, resolve);
    } else {
      chrome.storage.local.remove(AUTH_TOKEN_KEY, resolve);
    }
  });
}

export async function getSupabaseUrl(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([SUPABASE_URL_KEY], (result) => {
      resolve((result[SUPABASE_URL_KEY] as string | undefined) ?? null);
    });
  });
}

/**
 * Fetch JSON via the background service worker to avoid CORS /
 * Private Network Access restrictions in content scripts.
 */
async function bgFetch<T>(url: string, headers?: Record<string, string>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "fetch", url, headers }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response?.ok) {
        reject(new Error(response?.error ?? "bgFetch failed"));
      } else {
        resolve(response.data as T);
      }
    });
  });
}

async function bgPost<T>(
  url: string,
  body: unknown,
  headers?: Record<string, string>
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "fetch-post",
        url,
        headers: {
          "Content-Type": "application/json",
          ...(headers ?? {}),
        },
        body: JSON.stringify(body),
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!response?.ok) {
          reject(new Error(response?.error ?? "bgPost failed"));
        } else {
          resolve(response.data as T);
        }
      }
    );
  });
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ---------- Public API ----------

export async function listCollections(): Promise<CollectionSummary[]> {
  const base = await getServerUrl();
  return bgFetch<CollectionSummary[]>(`${base}/collections`);
}

export async function fetchCollection(slug: string): Promise<CollectionDetail> {
  const base = await getServerUrl();
  const headers = await authHeaders();
  return bgFetch<CollectionDetail>(
    `${base}/collections/${encodeURIComponent(slug)}`,
    headers
  );
}

export async function listMyLicenses(): Promise<LicenseInfo[]> {
  const base = await getServerUrl();
  const headers = await authHeaders();
  return bgFetch<LicenseInfo[]>(`${base}/me/licenses`, headers);
}

export async function acquireCollection(collectionId: string): Promise<LicenseInfo> {
  const base = await getServerUrl();
  const headers = await authHeaders();
  return bgPost<LicenseInfo>(`${base}/me/licenses/acquire`, {
    collection_id: collectionId,
  }, headers);
}

// Legacy: list packs (for backward compat during transition)
export async function listPacks(): Promise<PackSummary[]> {
  const base = await getServerUrl();
  return bgFetch<PackSummary[]>(`${base}/packs`);
}

/**
 * Returns the active collection, preferring the network and falling back
 * to a cached copy. Returns null if no collection is selected or both miss.
 */
export async function loadActiveCollection(): Promise<CollectionDetail | null> {
  const slug = await getActiveSlug();
  if (!slug) return null;

  try {
    const collection = await fetchCollection(slug);
    const entry: CacheEntry = { collection, fetchedAt: Date.now() };
    chrome.storage.local.set({ [CACHE_KEY]: entry });
    return collection;
  } catch (e) {
    console.warn("[murky] collection fetch failed, trying cache", e);
    return new Promise((resolve) => {
      chrome.storage.local.get([CACHE_KEY], (result) => {
        const cached = result[CACHE_KEY] as CacheEntry | undefined;
        if (cached?.collection?.slug === slug) {
          resolve(cached.collection);
        } else {
          resolve(null);
        }
      });
    });
  }
}
