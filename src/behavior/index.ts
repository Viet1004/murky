/**
 * Toy behavior collector.
 *
 * Emits impression/unmask/remask/click events to /behavior/events
 * on the murky-server, batched every 10s. Gated on a per-user opt-in
 * (`murkyBehaviorEnabled`) that defaults to OFF. Collects nothing until
 * the user flips it on in the popup.
 *
 * Removable: delete this folder, remove the `initBehaviorCollector()`
 * and `recordBehavior*` imports from content.ts, and the popup wiring.
 */

type InteractionType = "impression" | "unmask" | "remask" | "click" | "page_view";

type PageType =
  | "search"
  | "category"
  | "flash_sale"
  | "home"
  | "product_detail"
  | "unknown";

interface PageInfo {
  url: string;
  page_type: PageType;
  query: string | null;
  category_path: string[];
}

interface Event {
  type: InteractionType;
  product_key: string | null;
  was_masked: boolean | null;
  latency_ms: number | null;
  page: PageInfo | null;
  features: Record<string, unknown>;
  client_ts: number;
}

const FLUSH_INTERVAL_MS = 10_000;
const MAX_BUFFER = 500;
const BEHAVIOR_ENABLED_KEY = "murkyBehaviorEnabled";
const ANON_ID_KEY = "murkyAnonId";

let siteId = "unknown";
let sessionId = "";
let anonId = "";
let enabled = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let impressionTs = new Map<string, number>(); // product_key -> first seen ms
const buffer: Event[] = [];

// ---------- Public API ----------

export async function initBehaviorCollector(site: string): Promise<void> {
  siteId = site;

  const result = await storageGet<{
    [BEHAVIOR_ENABLED_KEY]?: boolean;
    [ANON_ID_KEY]?: string;
  }>([BEHAVIOR_ENABLED_KEY, ANON_ID_KEY]);

  enabled = result[BEHAVIOR_ENABLED_KEY] === true;

  anonId = result[ANON_ID_KEY] ?? "";
  if (!anonId) {
    anonId = `anon-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await storageSet({ [ANON_ID_KEY]: anonId });
  }

  sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  // React to toggle flips live — no page reload required.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes[BEHAVIOR_ENABLED_KEY]) {
      enabled = changes[BEHAVIOR_ENABLED_KEY].newValue === true;
      if (!enabled) buffer.length = 0;
    }
  });

  if (!flushTimer) {
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    window.addEventListener("beforeunload", () => {
      void flush();
    });
  }

  // Page-view event for the initial load.
  recordBehaviorImpression(null, false, { reason: "page_view" });
}

export function recordBehaviorImpression(
  productKey: string | null,
  wasMasked: boolean,
  features: Record<string, unknown> = {}
): void {
  if (!enabled) return;
  const now = Date.now();
  if (productKey && !impressionTs.has(productKey)) {
    impressionTs.set(productKey, now);
  }
  push({
    type: productKey ? "impression" : "page_view",
    product_key: productKey,
    was_masked: wasMasked,
    latency_ms: null,
    page: currentPage(),
    features,
    client_ts: now,
  });
}

export function recordBehaviorUnmask(productKey: string): void {
  if (!enabled) return;
  push({
    type: "unmask",
    product_key: productKey,
    was_masked: true,
    latency_ms: latencySince(productKey),
    page: currentPage(),
    features: {},
    client_ts: Date.now(),
  });
}

export function recordBehaviorRemask(productKey: string): void {
  if (!enabled) return;
  push({
    type: "remask",
    product_key: productKey,
    was_masked: false,
    latency_ms: latencySince(productKey),
    page: currentPage(),
    features: {},
    client_ts: Date.now(),
  });
}

export function recordBehaviorClick(productKey: string, wasMasked: boolean): void {
  if (!enabled) return;
  push({
    type: "click",
    product_key: productKey,
    was_masked: wasMasked,
    latency_ms: latencySince(productKey),
    page: currentPage(),
    features: {},
    client_ts: Date.now(),
  });
}

// ---------- Internals ----------

function push(ev: Event): void {
  buffer.push(ev);
  if (buffer.length >= MAX_BUFFER) void flush();
}

function latencySince(productKey: string): number | null {
  const t0 = impressionTs.get(productKey);
  return t0 == null ? null : Date.now() - t0;
}

function currentPage(): PageInfo {
  const url = window.location.href;
  return {
    url,
    page_type: classifyPage(url),
    query: extractQuery(url),
    category_path: [],
  };
}

function classifyPage(url: string): PageType {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    if (p.includes("/flash_sale") || p.includes("/flash-sale")) return "flash_sale";
    if (p.startsWith("/search") || u.searchParams.has("keyword")) return "search";
    if (/-i\.\d+\.\d+/.test(p)) return "product_detail"; // shopee product
    if (p === "/" || p === "") return "home";
    return "category";
  } catch {
    return "unknown";
  }
}

function extractQuery(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get("keyword") ?? u.searchParams.get("q") ?? null;
  } catch {
    return null;
  }
}

async function flush(): Promise<void> {
  if (!enabled || buffer.length === 0) return;
  const events = buffer.splice(0, buffer.length);

  const base = await getServerUrl();
  const url = `${base}/behavior/events`;
  const body = JSON.stringify({
    session_id: sessionId,
    anon_id: anonId,
    site_id: siteId,
    events,
  });

  try {
    await bgPost(url, body);
  } catch (e) {
    console.debug("[murky behavior] flush failed, dropping batch", e);
    // Intentionally drop on failure — this is telemetry, not transactions.
  }
}

// ---------- bg-worker glue ----------

function storageGet<T extends object>(keys: string[]): Promise<T> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result as T));
  });
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set(items, () => resolve()));
}

async function getServerUrl(): Promise<string> {
  const result = await storageGet<{ murkyServerUrl?: string }>(["murkyServerUrl"]);
  return (result.murkyServerUrl ?? "http://localhost:5173").replace(/\/$/, "");
}

function bgPost(url: string, body: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "fetch-post",
        url,
        headers: { "Content-Type": "application/json" },
        body,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!response?.ok) {
          reject(new Error(response?.error ?? "bgPost failed"));
        } else {
          resolve(response.data);
        }
      }
    );
  });
}
