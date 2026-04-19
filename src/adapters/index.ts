import { SiteAdapter } from "./types";
import { shopeeAdapter } from "./shopee";

export type { SiteAdapter } from "./types";

/**
 * Registry of all known site adapters. Order matters only if two
 * adapters match the same hostname — the first match wins.
 */
const ADAPTERS: SiteAdapter[] = [shopeeAdapter];

/**
 * Picks the adapter for a given hostname. Returns null if no adapter
 * handles the site.
 */
export function pickAdapter(hostname: string): SiteAdapter | null {
  for (const adapter of ADAPTERS) {
    if (adapter.matches(hostname)) return adapter;
  }
  return null;
}

export { shopeeAdapter };
