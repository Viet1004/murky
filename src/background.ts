/**
 * Background service worker.
 *
 * Responsibilities:
 *   1. Proxy fetch requests from content scripts / popup so they aren't
 *      subject to the page's CORS / Private Network Access restrictions.
 *   2. Click-trace registry: when a content script reports the user
 *      followed a tracked card, watch tab navigation and inject a gentle
 *      regret prompt on the destination page after a dwell period.
 *   3. Dynamic content-script registration: when the picker saves a
 *      selector for a new origin, register the content script on that
 *      origin so future visits auto-mask.
 *
 * Message types handled:
 *   { type: "fetch", url, headers? }
 *   { type: "fetch-post", url, headers?, body }
 *   { type: "trace-click", href, siteId, productKey, title, wasMasked,
 *                          userBypassedMask, clickedAt }
 *   { type: "regret-response", event }
 *   { type: "register-origin", origin }
 *   { type: "unregister-origin", origin }
 *   { type: "run-picker" }  (from popup — injects the picker overlay)
 */

import type { RegretContext, RegretEvent } from "./regret/client";
import {
  pullAndMerge,
  runSync,
  pushSiteSelector,
  deleteSiteSelectorOnServer,
  clearAllOnServer,
  watchStorageForPreferenceChanges,
  isSyncEnabled,
} from "./sync";
import type { SyncMode } from "./sync";
import type { SiteSelectorConfig } from "./picker/store";

const ALLOWED_EXTERNAL_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:8000",
  "https://gum2fjwx5t.ap-southeast-1.awsapprunner.com",
]);
const DEFAULT_SERVER_URL = "https://gum2fjwx5t.ap-southeast-1.awsapprunner.com";
const SERVER_URL_KEY = "murkyServerUrl";
const AUTH_TOKEN_KEY = "murkyAuthToken";
const AUTH_EMAIL_KEY = "murkyAuthEmail";
const AUTH_REFRESH_TOKEN_KEY = "murkyAuthRefreshToken";
const AUTH_EXPIRES_AT_KEY = "murkyAuthExpiresAt";
const REGRET_RATE_KEY = "murkyRegretRate";
const SITE_SELECTORS_KEY = "murkySiteSelectors";

const TRACE_TTL_MS = 30_000;          // a trace expires if no nav within 30s
const TRACE_MAX_PENDING = 100;
const REGRET_MAX_PER_ORIGIN_WEEK = 3;
const REGRET_MAX_PER_SESSION = 1;
const REGRET_MIN_GAP_MS = 30 * 60 * 1000;  // 30 min between prompts
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

interface PendingTrace {
  traceId: string;
  href: string;
  hrefOrigin: string;
  hrefPathPrefix: string;
  siteId: string;
  productKey: string;
  title: string | null;
  wasMasked: boolean;
  userBypassedMask: boolean;
  clickedAt: number;
  expiresAt: number;
  /** True once we've injected the prompt — never inject twice. */
  fired: boolean;
}

interface RegretRateRecord {
  /** Per-origin timestamps of past prompts (last 7 days). */
  perOrigin: Record<string, number[]>;
  /** Global "last shown" timestamp for cross-origin gap. */
  lastShownAt: number;
  /** ms timestamp of background start — proxy for "session". */
  sessionStart: number;
  /** Count shown in current session. */
  shownThisSession: number;
}

let publicConfigPromise: Promise<PublicConfig> | null = null;
const pendingTraces: PendingTrace[] = [];
const sessionStart = Date.now();
let traceSequence = 0;

function nextTraceId(): string {
  traceSequence++;
  return `t-${sessionStart}-${traceSequence}`;
}

// --- Storage helpers ----------------------------------------------------

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

// --- Server URL + auth (unchanged from previous version) ----------------

async function getServerUrl(): Promise<string> {
  const result = await storageGet<{ [SERVER_URL_KEY]?: string }>([SERVER_URL_KEY]);
  return (result[SERVER_URL_KEY] ?? DEFAULT_SERVER_URL).replace(/\/$/, "");
}

async function isMurkyServerRequest(url: string): Promise<boolean> {
  const serverUrl = await getServerUrl();
  try {
    return new URL(url).origin === new URL(serverUrl).origin;
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
  return { supabaseUrl: supabaseUrl.replace(/\/$/, ""), publishableKey };
}

async function getPublicConfig(): Promise<PublicConfig> {
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
    console.warn("[murky background] failed to refresh auth token", err);
    return null;
  }
}

async function authHeadersForRequest(
  url: string,
  headers?: Record<string, string>
): Promise<Record<string, string> | undefined> {
  if (!(await isMurkyServerRequest(url))) return headers;
  const next = { ...(headers ?? {}) };
  delete next.Authorization;
  delete next.authorization;
  const token = await getValidAccessToken();
  if (token) next.Authorization = `Bearer ${token}`;
  return Object.keys(next).length > 0 ? next : undefined;
}

// --- Click-trace registry -----------------------------------------------

function pruneTraces(): void {
  const now = Date.now();
  for (let i = pendingTraces.length - 1; i >= 0; i--) {
    if (pendingTraces[i].expiresAt <= now || pendingTraces[i].fired) {
      pendingTraces.splice(i, 1);
    }
  }
  while (pendingTraces.length > TRACE_MAX_PENDING) pendingTraces.shift();
}

function registerTrace(message: {
  href: string;
  siteId: string;
  productKey: string;
  title: string | null;
  wasMasked: boolean;
  userBypassedMask: boolean;
  clickedAt: number;
}): void {
  pruneTraces();
  let hrefOrigin = "";
  let hrefPathPrefix = "";
  try {
    const u = new URL(message.href);
    hrefOrigin = u.origin;
    // For matching: most product URLs share a prefix even after redirects.
    // Take the first path segment as a coarse "is this the same product"
    // hint; final URL match is tighter, this is the early gate.
    hrefPathPrefix = u.pathname.split("/").slice(0, 3).join("/");
  } catch {
    return;
  }
  pendingTraces.push({
    traceId: nextTraceId(),
    href: message.href,
    hrefOrigin,
    hrefPathPrefix,
    siteId: message.siteId,
    productKey: message.productKey,
    title: message.title,
    wasMasked: message.wasMasked,
    userBypassedMask: message.userBypassedMask,
    clickedAt: message.clickedAt,
    expiresAt: Date.now() + TRACE_TTL_MS,
    fired: false,
  });
}

function findTraceForUrl(url: string): PendingTrace | null {
  pruneTraces();
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  // Prefer most recent matching trace (LIFO).
  for (let i = pendingTraces.length - 1; i >= 0; i--) {
    const t = pendingTraces[i];
    if (t.fired) continue;
    if (t.hrefOrigin && t.hrefOrigin !== target.origin) continue;
    if (
      t.hrefPathPrefix &&
      !target.pathname.startsWith(t.hrefPathPrefix.split("/").slice(0, 2).join("/"))
    ) {
      continue;
    }
    return t;
  }
  return null;
}

// --- Rate limiting ------------------------------------------------------

async function loadRate(): Promise<RegretRateRecord> {
  const r = await storageGet<{ [REGRET_RATE_KEY]?: RegretRateRecord }>([REGRET_RATE_KEY]);
  const rec = r[REGRET_RATE_KEY];
  if (!rec || rec.sessionStart !== sessionStart) {
    return {
      perOrigin: rec?.perOrigin ?? {},
      lastShownAt: rec?.lastShownAt ?? 0,
      sessionStart,
      shownThisSession: 0,
    };
  }
  return rec;
}

function pruneRate(rec: RegretRateRecord): void {
  const cutoff = Date.now() - WEEK_MS;
  for (const origin of Object.keys(rec.perOrigin)) {
    rec.perOrigin[origin] = rec.perOrigin[origin].filter((ts) => ts > cutoff);
    if (rec.perOrigin[origin].length === 0) delete rec.perOrigin[origin];
  }
}

async function canShowPrompt(origin: string): Promise<boolean> {
  const rec = await loadRate();
  pruneRate(rec);
  const now = Date.now();
  if (rec.shownThisSession >= REGRET_MAX_PER_SESSION) return false;
  if (now - rec.lastShownAt < REGRET_MIN_GAP_MS) return false;
  const list = rec.perOrigin[origin] ?? [];
  if (list.length >= REGRET_MAX_PER_ORIGIN_WEEK) return false;
  return true;
}

async function recordPromptShown(origin: string): Promise<void> {
  const rec = await loadRate();
  pruneRate(rec);
  const now = Date.now();
  rec.lastShownAt = now;
  rec.shownThisSession += 1;
  rec.perOrigin[origin] = [...(rec.perOrigin[origin] ?? []), now];
  await storageSet({ [REGRET_RATE_KEY]: rec });
}

// --- Prompt injection ---------------------------------------------------

function buildPromptText(trace: PendingTrace): string {
  // Gentle, ambiguous, no shame. Mention what we know (title) only if we have it.
  if (trace.userBypassedMask) {
    return trace.title
      ? `You unmasked "${truncate(trace.title, 60)}" and opened it. Does it still feel like a fit for what you wanted?`
      : `You unmasked this and opened it. Does it still feel like a fit for what you wanted?`;
  }
  return trace.title
    ? `Quick check — does "${truncate(trace.title, 60)}" still feel like a fit for what you're shopping for?`
    : `Quick check — does this still feel like a fit for what you're shopping for?`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

async function injectRegretPrompt(tabId: number, trace: PendingTrace): Promise<void> {
  const promptText = buildPromptText(trace);
  const context: RegretContext = {
    href: trace.href,
    siteId: trace.siteId,
    productKey: trace.productKey,
    title: trace.title,
    wasMasked: trace.wasMasked,
    userBypassedMask: trace.userBypassedMask,
    clickedAt: trace.clickedAt,
    traceId: trace.traceId,
  };
  // Stash the payload on window via an arg-passed function, then load
  // the bundled regret script which reads it.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: (ctx: RegretContext, text: string) => {
        (window as unknown as { __MURKY_REGRET_PAYLOAD__: unknown }).__MURKY_REGRET_PAYLOAD__ = {
          context: ctx,
          promptText: text,
        };
      },
      args: [context, promptText],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["dist/regret.js"],
    });
    trace.fired = true;
    await recordPromptShown(trace.hrefOrigin);
  } catch (err) {
    console.warn("[murky background] failed to inject regret prompt", err);
  }
}

// --- Tab navigation watcher --------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const url = tab.url;
  if (!url || !/^https?:/.test(url)) return;
  void handleNavigation(tabId, url);
});

async function handleNavigation(tabId: number, url: string): Promise<void> {
  const trace = findTraceForUrl(url);
  if (!trace) return;
  let originOk = "";
  try {
    originOk = new URL(url).origin;
  } catch {
    return;
  }
  // The regret prompt's only purpose is to collect a labeled training
  // signal. If the user hasn't opted into telemetry, do not inject it —
  // even though the prompt UI itself is local, the response would POST
  // to /behavior/regret. Honor the toggle at the gate, not at the POST.
  if (!(await behaviorTelemetryEnabled())) return;
  if (!(await canShowPrompt(originOk))) return;
  // Inject — the regret script handles its own dwell timer.
  await injectRegretPrompt(tabId, trace);
}

async function behaviorTelemetryEnabled(): Promise<boolean> {
  const r = await storageGet<{ murkyBehaviorEnabled?: boolean }>([
    "murkyBehaviorEnabled",
  ]);
  return r.murkyBehaviorEnabled === true;
}

// --- Dynamic content-script registration --------------------------------

function scriptIdForOrigin(origin: string): string {
  return `murky-cs:${origin}`;
}

async function unregisterOriginContentScript(origin: string): Promise<void> {
  const id = scriptIdForOrigin(origin);
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
    console.debug("[murky background] unregistered content script for", origin);
  } catch (err) {
    // Ignore — the script may simply not have been registered yet.
    console.debug("[murky background] unregister noop for", origin, err);
  }
  // Mirror the delete to the server if sync is enabled. No-op otherwise.
  void deleteSiteSelectorOnServer(origin);
}

async function registerOriginContentScript(origin: string): Promise<void> {
  const matches = originToMatchPattern(origin);
  if (!matches) return;
  const id = scriptIdForOrigin(origin);
  try {
    // Unregister first so re-saves don't fail with "already exists".
    await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => undefined);
    await chrome.scripting.registerContentScripts([
      {
        id,
        matches: [matches],
        js: ["dist/content.js"],
        css: ["styles.css"],
        runAt: "document_idle",
      },
    ]);
    console.debug("[murky background] registered content script for", matches);
  } catch (err) {
    console.warn("[murky background] failed to register content script", origin, err);
  }
  // Push the selector to the server if sync is enabled. No-op otherwise.
  void pushSiteSelectorIfPresent(origin);
}

async function pushSiteSelectorIfPresent(origin: string): Promise<void> {
  if (!(await isSyncEnabled())) return;
  const r = await storageGet<{ murkySiteSelectors?: Record<string, SiteSelectorConfig> }>([
    "murkySiteSelectors",
  ]);
  const config = r.murkySiteSelectors?.[origin];
  if (config) await pushSiteSelector(config);
}

// --- Mask-first CSS injection -------------------------------------------
//
// On every top-level navigation, look up whether the destination origin
// has a saved site selector. If so, inject a tiny stylesheet at the
// earliest possible moment (webNavigation.onCommitted fires before the
// document loads its content) that hides matching elements. The content
// script later tags each card with .murky-revealed (safe) or
// .murky-masked (mask art mounted on top), which un-hides it.
//
// A 3-second CSS-only safety animation re-shows any card that never got
// a verdict — so a slow scorer or a stuck content script never leaves
// the page permanently blank.

const MASK_FIRST_SAFETY_MS = 3000;

function buildMaskFirstCss(selector: string): string {
  // Cards without a verdict class are hidden. The keyframe at delay
  // MASK_FIRST_SAFETY_MS auto-reveals anything that's still unsorted.
  return `
    ${selector}:not(.murky-revealed):not(.murky-masked) {
      visibility: hidden;
      animation: murky-safety-reveal 0s linear ${MASK_FIRST_SAFETY_MS}ms forwards;
    }
    @keyframes murky-safety-reveal {
      to { visibility: visible; }
    }
  `;
}

async function injectMaskFirstCss(tabId: number, origin: string): Promise<void> {
  // Bail if the user has paused the extension globally — otherwise we'd
  // hide cards on a paused install that has no content script to reveal them.
  const enabled = await storageGet<{ murkyEnabled?: boolean }>(["murkyEnabled"]);
  if (enabled.murkyEnabled === false) return;

  const r = await storageGet<{ [SITE_SELECTORS_KEY]?: Record<string, SiteSelectorConfig> }>([
    SITE_SELECTORS_KEY,
  ]);
  const config = r[SITE_SELECTORS_KEY]?.[origin];
  if (!config?.cardSelector) return;

  // Skip mask-first when the user has selected the embedding scorer but
  // the model isn't ready yet. Otherwise the user stares at blank cards
  // for the duration of the model download (5-10s) on first run. Once
  // the model is ready, subsequent navigations get mask-first.
  const scorerR = await storageGet<{ murkyScorerId?: string }>(["murkyScorerId"]);
  if (scorerR.murkyScorerId === "embedding-minilm") {
    const statusR = await storageGet<{
      murkyEmbeddingModelStatus?: { status?: string };
    }>(["murkyEmbeddingModelStatus"]);
    if (statusR.murkyEmbeddingModelStatus?.status !== "ready") return;
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      css: buildMaskFirstCss(config.cardSelector),
    });
  } catch (err) {
    // CSP-locked sites or detached tabs can throw. Silent — page just
    // falls back to "no mask-first," same as before this feature shipped.
    console.debug("[murky background] mask-first insertCSS failed", origin, err);
  }
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return; // top frame only
  if (!details.url || !/^https?:/.test(details.url)) return;
  let origin = "";
  try {
    origin = new URL(details.url).origin;
  } catch {
    return;
  }
  void injectMaskFirstCss(details.tabId, origin);
});

function originToMatchPattern(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/** Re-hydrate registrations on extension start (service worker may restart). */
async function hydrateRegistrations(): Promise<void> {
  const r = await storageGet<{
    [SITE_SELECTORS_KEY]?: Record<string, { origin: string }>;
  }>([SITE_SELECTORS_KEY]);
  const store = r[SITE_SELECTORS_KEY] ?? {};
  for (const origin of Object.keys(store)) {
    await registerOriginContentScript(origin);
  }
}

void hydrateRegistrations();

// Run a sync pull on service-worker startup so a fresh install or browser
// restart picks up anything saved on another device. No-op when sync is
// off or signed out.
void pullAndMerge();

// React to focus-prompt / scorer-id changes by pushing preferences to
// the server (gated inside the helper).
watchStorageForPreferenceChanges();

// --- Picker invocation from popup --------------------------------------

async function runPicker(): Promise<{ ok: true } | { ok: false; error: string }> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return { ok: false, error: "no active tab" };
  if (!activeTab.url || !/^https?:/.test(activeTab.url)) {
    return { ok: false, error: "picker only works on http(s) pages" };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ["dist/picker.js"],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Pre-warm the embedding model from the popup's "Download now" button.
 * The model lives in the content-script context (the page's network
 * world), so we inject a tiny loader into the active tab. The loader
 * imports dist/content.js's exported preloader via window-attached
 * handle — which the content script publishes when it boots.
 *
 * Falls back gracefully if there's no http(s) tab: the user can just
 * navigate to a real page; the next score call will trigger the load.
 */
async function preloadEmbeddingModelInActiveTab(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) return { ok: false, error: "no active tab" };
    if (!activeTab.url || !/^https?:/.test(activeTab.url)) {
      return { ok: false, error: "open any http(s) page first, then click again" };
    }
    // Inject a stub that calls the content script's exported preload
    // handle. If the content script isn't present on this tab (no
    // saved selector / no built-in adapter), the stub no-ops and we
    // surface a friendly error instead of silently succeeding.
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      world: "ISOLATED",
      func: () => {
        const handle = (window as unknown as {
          __MURKY_PRELOAD_EMBEDDING__?: () => Promise<void>;
        }).__MURKY_PRELOAD_EMBEDDING__;
        if (typeof handle === "function") {
          void handle();
          return { triggered: true };
        }
        return { triggered: false };
      },
    });
    const triggered = results?.[0]?.result?.triggered === true;
    if (!triggered) {
      return {
        ok: false,
        error:
          "Murky isn't running on this page. Open a site you've picked (or shopee.vn) and try again.",
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Mirror an error to the model-status key so the popup badge updates. */
function reportPreloadError(error: string): void {
  void chrome.storage.local.set({
    murkyEmbeddingModelStatus: {
      status: "error",
      bytes: 0,
      updatedAt: Date.now(),
      error,
    },
  });
}

// --- Server forwarding for regret events --------------------------------

async function forwardRegretEvent(event: RegretEvent): Promise<void> {
  const base = await getServerUrl();
  const url = `${base}/behavior/regret`;
  const headers = await authHeadersForRequest(url, { "Content-Type": "application/json" });
  try {
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
    });
  } catch (err) {
    // Telemetry — swallow. Don't block the user on a network failure.
    console.debug("[murky background] regret forward failed", err);
  }
}

// --- Message router -----------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "fetch" || message.type === "fetch-post") {
    const isPost = message.type === "fetch-post";
    authHeadersForRequest(message.url, message.headers)
      .then((headers) => {
        const fetchOptions: RequestInit = { method: isPost ? "POST" : "GET" };
        if (headers) fetchOptions.headers = headers;
        if (isPost && message.body) fetchOptions.body = message.body;
        return fetch(message.url, fetchOptions);
      })
      .then((res) => {
        if (!res.ok) return res.text().then((text) => { throw new Error(`HTTP ${res.status}: ${text}`); });
        return res.json();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "trace-click") {
    registerTrace(message);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "regret-response") {
    void forwardRegretEvent(message.event as RegretEvent);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "register-origin") {
    void registerOriginContentScript(message.origin);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "unregister-origin") {
    void unregisterOriginContentScript(message.origin);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "sync-toggle") {
    // The popup chooses the sync mode at first-time enable via the
    // "merge / replace / cancel" dialog. After that, "normal" is sent
    // on subsequent enables. On disable, nothing to do — push/pull
    // helpers self-gate on isSyncEnabled().
    if (message.enabled) {
      const mode: SyncMode =
        message.action === "merge"
          ? "merge"
          : message.action === "replace"
            ? "replace"
            : "normal";
      void runSync(mode);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "sync-clear") {
    void clearAllOnServer()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "preload-embedding-model") {
    // Respond synchronously so the popup's message port doesn't time
    // out while the SW spins up scripting/executeScript. Real progress
    // (and any error) flows back via storage.onChanged on
    // murkyEmbeddingModelStatus, which the popup is already listening on.
    void preloadEmbeddingModelInActiveTab().then(
      (r) => { if (!r.ok) reportPreloadError(r.error); },
      (err) => reportPreloadError(String(err))
    );
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "run-picker") {
    void runPicker().then(sendResponse);
    return true;
  }

  return false;
});

// --- External (web app) messages — unchanged ---------------------------

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!sender.origin || !ALLOWED_EXTERNAL_ORIGINS.has(sender.origin)) {
    console.warn("[murky background] rejected external message", { origin: sender.origin, type: message?.type });
    sendResponse({ ok: false, error: "origin not allowed" });
    return false;
  }
  if (message?.type === "auth-token") {
    const token = typeof message.token === "string" ? message.token : "";
    const email = typeof message.email === "string" ? message.email : "";
    const refreshToken = typeof message.refreshToken === "string" ? message.refreshToken : "";
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
  if (message?.type === "set-active-collection") {
    const slug = typeof message.slug === "string" ? message.slug.trim() : "";
    if (!slug) {
      sendResponse({ ok: false, error: "missing slug" });
      return false;
    }
    chrome.storage.local.set({ murkyActivePack: slug }, () => sendResponse({ ok: true }));
    return true;
  }
  console.warn("[murky background] unknown external message", { origin: sender.origin, type: message?.type });
  sendResponse({ ok: false, error: "unknown message type" });
  return false;
});
