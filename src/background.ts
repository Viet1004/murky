/**
 * Background service worker.
 *
 * Proxies fetch requests from content scripts / popup so they aren't
 * subject to the page's CORS / Private Network Access restrictions.
 *
 * Message types:
 *   { type: "fetch", url, headers? }           — GET request
 *   { type: "fetch-post", url, headers?, body } — POST request (string body)
 */

const ALLOWED_EXTERNAL_ORIGIN = "http://localhost:8000";
const DEFAULT_SERVER_URL = "http://localhost:8000";
const SERVER_URL_KEY = "murkyServerUrl";
const AUTH_TOKEN_KEY = "murkyAuthToken";
const AUTH_EMAIL_KEY = "murkyAuthEmail";
const AUTH_REFRESH_TOKEN_KEY = "murkyAuthRefreshToken";
const AUTH_EXPIRES_AT_KEY = "murkyAuthExpiresAt";

interface PublicConfig {
  supabaseUrl: string;
  publishableKey: string;
}

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

let publicConfigPromise: Promise<PublicConfig> | null = null;

function storageGet<T extends object>(keys: string[]): Promise<T> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result as T));
  });
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function storageRemove(keys: string[]): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

async function getServerUrl(): Promise<string> {
  const result = await storageGet<{ [SERVER_URL_KEY]?: string }>([
    SERVER_URL_KEY,
  ]);
  return (result[SERVER_URL_KEY] ?? DEFAULT_SERVER_URL).replace(/\/$/, "");
}

async function isMurkyServerRequest(url: string): Promise<boolean> {
  const serverUrl = await getServerUrl();
  try {
    const requestUrl = new URL(url);
    const configuredUrl = new URL(serverUrl);
    return requestUrl.origin === configuredUrl.origin;
  } catch {
    return false;
  }
}

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

  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    publishableKey,
  };
}

async function getPublicConfig(): Promise<PublicConfig> {
  if (!publicConfigPromise) {
    publicConfigPromise = getServerUrl()
      .then((serverUrl) => fetch(`${serverUrl}/api/public-config`))
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`public config HTTP ${res.status}`);
        }
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

async function clearAuth(): Promise<void> {
  await storageRemove([
    AUTH_TOKEN_KEY,
    AUTH_EMAIL_KEY,
    AUTH_REFRESH_TOKEN_KEY,
    AUTH_EXPIRES_AT_KEY,
  ]);
}

async function getValidAccessToken(): Promise<string | null> {
  const auth = await storageGet<StoredAuth>([
    AUTH_TOKEN_KEY,
    AUTH_REFRESH_TOKEN_KEY,
    AUTH_EXPIRES_AT_KEY,
  ]);
  const token = auth[AUTH_TOKEN_KEY];
  const refreshToken = auth[AUTH_REFRESH_TOKEN_KEY];
  const expiresAt = auth[AUTH_EXPIRES_AT_KEY];

  if (!token) return null;

  if (typeof expiresAt === "number" && expiresAt - Date.now() > 60_000) {
    return token;
  }

  if (!refreshToken) return null;

  try {
    const { supabaseUrl, publishableKey } = await getPublicConfig();
    const res = await fetch(
      `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: {
          apikey: publishableKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }
    );

    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        await clearAuth();
      }
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
    console.warn("[murky background] failed to refresh auth token", err);
    return null;
  }
}

async function authHeadersForRequest(
  url: string,
  headers?: Record<string, string>
): Promise<Record<string, string> | undefined> {
  if (!(await isMurkyServerRequest(url))) {
    return headers;
  }

  const nextHeaders = { ...(headers ?? {}) };
  delete nextHeaders.Authorization;
  delete nextHeaders.authorization;

  const token = await getValidAccessToken();
  if (token) {
    nextHeaders.Authorization = `Bearer ${token}`;
  }

  return Object.keys(nextHeaders).length > 0 ? nextHeaders : undefined;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "fetch" || message.type === "fetch-post") {
    const isPost = message.type === "fetch-post";
    authHeadersForRequest(message.url, message.headers)
      .then((headers) => {
        const fetchOptions: RequestInit = {
          method: isPost ? "POST" : "GET",
        };
        if (headers) {
          fetchOptions.headers = headers;
        }
        if (isPost && message.body) {
          fetchOptions.body = message.body;
        }
        return fetch(message.url, fetchOptions);
      })
      .then((res) => {
        if (!res.ok) {
          return res.text().then((text) => {
            throw new Error(`HTTP ${res.status}: ${text}`);
          });
        }
        return res.json();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (sender.origin !== ALLOWED_EXTERNAL_ORIGIN) {
    console.warn("[murky background] rejected external message", {
      origin: sender.origin,
      type: message?.type,
    });
    sendResponse({ ok: false, error: "origin not allowed" });
    return false;
  }

  if (message?.type === "auth-token") {
    const token = typeof message.token === "string" ? message.token : "";
    const email = typeof message.email === "string" ? message.email : "";
    const refreshToken =
      typeof message.refreshToken === "string" ? message.refreshToken : "";
    const expiresAt =
      typeof message.expiresAt === "number" && Number.isFinite(message.expiresAt)
        ? message.expiresAt
        : null;

    if (!token) {
      sendResponse({ ok: false, error: "missing token" });
      return false;
    }

    chrome.storage.local.set(
      {
        murkyAuthToken: token,
        murkyAuthEmail: email || null,
        murkyAuthRefreshToken: refreshToken || null,
        murkyAuthExpiresAt: expiresAt,
      },
      () => sendResponse({ ok: true })
    );
    return true;
  }

  console.warn("[murky background] unknown external message", {
    origin: sender.origin,
    type: message?.type,
  });
  sendResponse({ ok: false, error: "unknown message type" });
  return false;
});
