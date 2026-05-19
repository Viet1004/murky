/**
 * Decision cache for the scoring pipeline.
 *
 * Two tiers:
 *   - Hot:  in-memory Map for the current tab/page lifetime. ~µs lookup.
 *           Lost on tab close.
 *   - Warm: chrome.storage.local, capped at MAX_ENTRIES with LRU eviction.
 *           Survives across sessions, shared across all tabs.
 *
 * Cache key embeds the inputs that would change the verdict:
 *   `${productKey}|${scorerId}|${promptHash}`
 *
 * That means changing the focus prompt or switching scorers naturally
 * invalidates everything (the new key never finds the old entry). Stale
 * entries simply age out via LRU rather than needing explicit purge.
 *
 * Writes to chrome.storage are debounced (FLUSH_DEBOUNCE_MS) so a
 * 50-card page scan results in at most one storage write, not 50.
 *
 * Skipped scope (deliberate):
 *   - No TTL on entries. The web's titles don't change often; if they do,
 *     the user can re-pick the site or wait for LRU. Adds simplicity.
 *   - No IndexedDB tier. chrome.storage.local has a 10 MB quota; 5K
 *     entries × ~80 bytes ≈ 400 KB. Comfortable headroom.
 *   - No embedding cache (just decision cache). Per-product embeddings
 *     are large (~1.5 KB each); decisions are tiny. We can layer that
 *     in later if benchmarks show it pays off.
 */

const STORAGE_KEY = "murkyDecisionCache";
const MAX_ENTRIES = 5000;
const FLUSH_DEBOUNCE_MS = 1000;

export interface CacheRecord {
  shouldMask: boolean;
  scoredAt: number;
}

interface PersistedCache {
  /** key → record */
  entries: Record<string, CacheRecord>;
  /** Insertion / access order. Most recently used at the end. */
  order: string[];
}

class DecisionCache {
  private hot = new Map<string, CacheRecord>();
  private persisted: PersistedCache | null = null;
  private loadingPromise: Promise<void> | null = null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hits = 0;
  private misses = 0;

  /** Load the persisted cache once per page lifetime. */
  ensureLoaded(): Promise<void> {
    if (this.persisted) return Promise.resolve();
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = new Promise<void>((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (r) => {
        const stored = (r[STORAGE_KEY] as PersistedCache | undefined) ?? null;
        this.persisted = stored ?? { entries: {}, order: [] };
        // Defensive: if the persisted shape is corrupt (older versions,
        // partial writes), fall back to empty.
        if (!this.persisted.entries || !Array.isArray(this.persisted.order)) {
          this.persisted = { entries: {}, order: [] };
        }
        // Enforce the LRU cap on load too. Without this, a store that
        // somehow ended up over cap (older build, MAX_ENTRIES lowered,
        // partial write that left order/entries out of sync) would only
        // shrink via future set() calls. Trim from the oldest end so we
        // keep the most-recently-used entries.
        if (this.persisted.order.length > MAX_ENTRIES) {
          const overflow = this.persisted.order.length - MAX_ENTRIES;
          const evicted = this.persisted.order.splice(0, overflow);
          for (const key of evicted) delete this.persisted.entries[key];
          this.dirty = true;
          this.scheduleFlush();
        }
        // Also drop any entries that have no matching order slot (and
        // vice versa) so the two structures stay consistent — same
        // partial-write defense.
        const orderSet = new Set(this.persisted.order);
        for (const key of Object.keys(this.persisted.entries)) {
          if (!orderSet.has(key)) {
            delete this.persisted.entries[key];
            this.dirty = true;
          }
        }
        if (this.dirty) this.scheduleFlush();
        resolve();
      });
    });
    return this.loadingPromise;
  }

  get(key: string): CacheRecord | undefined {
    const hot = this.hot.get(key);
    if (hot) {
      this.hits++;
      return hot;
    }
    const cold = this.persisted?.entries[key];
    if (cold) {
      this.hits++;
      this.hot.set(key, cold); // promote to hot for the rest of the session
      this.touchLru(key);
      this.scheduleFlush();
      return cold;
    }
    this.misses++;
    return undefined;
  }

  set(key: string, record: CacheRecord): void {
    this.hot.set(key, record);
    if (!this.persisted) return;
    this.persisted.entries[key] = record;
    this.touchLru(key);
    while (this.persisted.order.length > MAX_ENTRIES) {
      const evicted = this.persisted.order.shift();
      if (evicted) delete this.persisted.entries[evicted];
    }
    this.scheduleFlush();
  }

  /** Move `key` to the end of the LRU order list. */
  private touchLru(key: string): void {
    if (!this.persisted) return;
    const idx = this.persisted.order.indexOf(key);
    if (idx >= 0) this.persisted.order.splice(idx, 1);
    this.persisted.order.push(key);
    this.dirty = true;
  }

  /** Wipe everything. Used when the user clicks "Delete sync data" etc. */
  async clear(reason: string): Promise<void> {
    console.debug("[murky cache] clear:", reason);
    this.hot.clear();
    this.persisted = { entries: {}, order: [] };
    this.dirty = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await new Promise<void>((resolve) =>
      chrome.storage.local.remove([STORAGE_KEY], () => resolve())
    );
  }

  /** Hit-rate stats since last reset. Useful for the timing log. */
  stats(): { hits: number; misses: number; size: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.persisted?.order.length ?? 0,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  private scheduleFlush(): void {
    if (!this.dirty || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, FLUSH_DEBOUNCE_MS);
  }

  private async flushNow(): Promise<void> {
    if (!this.persisted || !this.dirty) return;
    this.dirty = false;
    const snapshot = this.persisted;
    await new Promise<void>((resolve) =>
      chrome.storage.local.set({ [STORAGE_KEY]: snapshot }, () => resolve())
    );
  }
}

export const decisionCache = new DecisionCache();

/**
 * djb2-flavored hash, base36 encoded. Not cryptographic — used only to
 * bucket prompts into stable cache key fragments. Two prompts that
 * differ only in whitespace SHOULD collide → caller normalizes first.
 */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export function makeCacheKey(
  productKey: string,
  scorerId: string,
  promptHash: string
): string {
  return `${productKey}|${scorerId}|${promptHash}`;
}
