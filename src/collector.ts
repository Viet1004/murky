import { InteractionEvent, ProductId, ProductFeatures, CollectionData } from "./types";

const SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FLUSH_INTERVAL_MS = 10_000;

/** In-memory buffer of events, flushed to chrome.storage periodically */
const buffer: Map<string, InteractionEvent> = new Map();

let flushTimer: ReturnType<typeof setInterval> | null = null;
let currentSiteId: string = "unknown";

/**
 * Start the periodic flush to chrome.storage. The siteId is stamped
 * onto every event emitted during this session.
 */
export function startCollector(siteId: string): void {
  currentSiteId = siteId;
  if (flushTimer) return;
  flushTimer = setInterval(flushToStorage, FLUSH_INTERVAL_MS);
  window.addEventListener("beforeunload", flushToStorage);
}

/** Record that a product was seen (masked or not) */
export function recordImpression(
  productId: ProductId,
  features: ProductFeatures,
  wasMasked: boolean
): void {
  const key = productId.itemId;
  if (buffer.has(key)) return; // already tracking this product

  buffer.set(key, {
    siteId: currentSiteId,
    productId,
    features,
    wasMasked,
    unmaskedAt: wasMasked ? null : Date.now(), // if not masked, it's immediately visible
    clickedAt: null,
    remaskAt: null,
    pageUrl: window.location.href,
    sessionId: SESSION_ID,
    timestamp: Date.now(),
  });
}

/** Record that the user unmasked a product */
export function recordUnmask(itemId: string): void {
  const event = buffer.get(itemId);
  if (event && !event.unmaskedAt) {
    event.unmaskedAt = Date.now();
  }
}

/** Record that the user re-masked a product (decided not to engage) */
export function recordRemask(itemId: string): void {
  const event = buffer.get(itemId);
  if (event) {
    event.remaskAt = Date.now();
  }
}

/** Record that the user clicked through to a product page */
export function recordClick(itemId: string): void {
  const event = buffer.get(itemId);
  if (event) {
    event.clickedAt = Date.now();
  }
}

/** Flush the buffer to chrome.storage.local */
function flushToStorage(): void {
  if (buffer.size === 0) return;

  const events = Array.from(buffer.values());

  chrome.storage.local.get(["murkyCollection"], (result: { [key: string]: unknown }) => {
    const existing: CollectionData = (result.murkyCollection as CollectionData) ?? {
      events: [],
      sessionCount: 0,
    };

    existing.events.push(...events);
    // Keep only last 10,000 events to avoid storage bloat
    if (existing.events.length > 10_000) {
      existing.events = existing.events.slice(-10_000);
    }

    chrome.storage.local.set({ murkyCollection: existing });
  });

  buffer.clear();
}

/** Export all collected data as JSON (for the popup) */
export function exportCollectionData(): Promise<CollectionData> {
  return new Promise((resolve) => {
    // Flush current buffer first
    flushToStorage();

    setTimeout(() => {
      chrome.storage.local.get(["murkyCollection"], (result: { [key: string]: unknown }) => {
        resolve(
          (result.murkyCollection as CollectionData) ?? { events: [], sessionCount: 0 }
        );
      });
    }, 100);
  });
}
