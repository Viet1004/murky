/**
 * Collection loading from the murky-server.
 *
 * Fetches collections (which contain masks with typed layers) from the
 * server and provides them to the content script for rendering.
 * Falls back to bundled local icons if unreachable or no collection selected.
 */

// ---------- Server response types ----------

/** Generic asset slot from the v009+ wire format. */
export interface AssetInfo {
  id: string;
  role: string;
  position: number;
  url: string | null;
  text_content: string | null;
  mime: string | null;
  meta?: Record<string, unknown>;
}

export interface ServerMask {
  id: string;
  type: string;
  display_name: string;
  description: string | null;
  config: Record<string, unknown>;

  // v009+ render contract. The extension renders via render_html + behavior;
  // assets carries the typed source data for any UI that needs to introspect
  // (e.g. background's red-list picker filters role='layer').
  version: number;
  behavior: string;
  render_html: string | null;
  assets: AssetInfo[];
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

// ---------- Storage keys ----------

const DEFAULT_SERVER_URL = "https://gum2fjwx5t.ap-southeast-1.awsapprunner.com";
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
  return bgSendBody<T>("fetch-post", url, body, headers);
}

async function bgPut<T>(
  url: string,
  body: unknown,
  headers?: Record<string, string>
): Promise<T> {
  return bgSendBody<T>("fetch-put", url, body, headers);
}

function bgSendBody<T>(
  type: "fetch-post" | "fetch-put",
  url: string,
  body: unknown,
  headers?: Record<string, string>
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type,
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
          reject(new Error(response?.error ?? `${type} failed`));
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

/**
 * Tell the server a mask was fully revealed in the given collection.
 *
 * Server-side this removes the mask from the user's copy of the
 * collection (per sql/011_mask_reveals.sql) — the "unmask once, lose
 * it" friction loop. Re-acquiring the collection restores it.
 *
 * Fire-and-forget: callers should NOT await the result on the hot
 * path. Failures are logged at the bg layer; the local reveal animation
 * proceeds regardless so a flaky network never breaks the UX. Anonymous
 * users get a 401 here, which we swallow — without an account the
 * server can't track per-user state anyway.
 *
 * Cache invalidation: we proactively drop the cached collection blob
 * so the next page load re-fetches and the revealed mask drops out.
 */
export interface RevealResult {
  /** The server recorded the reveal (or it's a free/owner mask). */
  ok: boolean;
  /** The server returned 402 — a paid collection with no unmask-credits left. */
  paymentRequired: boolean;
}

export async function recordMaskReveal(
  maskId: string,
  collectionId: string
): Promise<RevealResult> {
  const base = await getServerUrl();
  const headers = await authHeaders();
  try {
    await bgPost<unknown>(
      `${base}/me/masks/${encodeURIComponent(maskId)}/reveal`,
      { collection_id: collectionId },
      headers
    );
    await new Promise<void>((resolve) => {
      chrome.storage.local.remove(CACHE_KEY, () => resolve());
    });
    return { ok: true, paymentRequired: false };
  } catch (e) {
    // The background worker surfaces non-2xx as "HTTP <status>: …". A 402 means
    // the buyer is out of unmask-credits — the caller keeps the mask covered and
    // prompts a purchase. Any other failure is treated as soft (don't block the
    // reveal on a network blip).
    const msg = e instanceof Error ? e.message : String(e);
    const paymentRequired = msg.includes("402");
    if (!paymentRequired) console.debug("[murky] recordMaskReveal failed (ignored)", e);
    return { ok: false, paymentRequired };
  }
}

// ---------- Library + active-collection preference ----------

export interface LibraryEntry {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  is_free: boolean;
  price_cents: number;
  currency: string;
  is_published: boolean;
  review_state: "draft" | "pending" | "approved" | "rejected";
  role: "owner" | "licensee";
  item_count: number;
}

export async function listMyLibrary(): Promise<LibraryEntry[]> {
  const base = await getServerUrl();
  const headers = await authHeaders();
  return bgFetch<LibraryEntry[]>(`${base}/me/library`, headers);
}

export interface ServerPreferences {
  focus_prompt: string | null;
  scorer_id: string | null;
  active_collection_slug: string | null;
  updated_at: string | null;
}

export async function getServerPreferences(): Promise<ServerPreferences | null> {
  const base = await getServerUrl();
  const headers = await authHeaders();
  try {
    return await bgFetch<ServerPreferences>(`${base}/me/preferences`, headers);
  } catch {
    return null;
  }
}

/**
 * Persist the active collection slug on the server. Best-effort: callers
 * should also write chrome.storage.local so the content script picks it up
 * synchronously.
 */
export async function setServerActiveCollection(
  slug: string | null
): Promise<void> {
  const base = await getServerUrl();
  const headers = await authHeaders();
  await bgPut<unknown>(
    `${base}/me/preferences`,
    { active_collection_slug: slug },
    headers
  );
}

/** Write the active slug into chrome.storage.local so the content script picks it up. */
export async function setLocalActiveSlug(slug: string | null): Promise<void> {
  return new Promise((resolve) => {
    if (slug) {
      chrome.storage.local.set({ [ACTIVE_PACK_KEY]: slug }, () => resolve());
    } else {
      chrome.storage.local.remove(ACTIVE_PACK_KEY, () => resolve());
    }
  });
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
