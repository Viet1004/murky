import { SiteAdapter } from "./types";
import { shopeeAdapter } from "./shopee";
import { getConfig } from "../picker/store";
import { buildUserAdapter } from "../picker/userAdapter";

export type { SiteAdapter } from "./types";

/**
 * Built-in adapters, hand-tuned per site. Order matters only if two
 * adapters match the same hostname — first match wins.
 */
const BUILT_IN_ADAPTERS: SiteAdapter[] = [shopeeAdapter];

/**
 * Pick an adapter for the current origin. Resolution order:
 *   1. User-trained adapter (from picker, stored per origin).
 *   2. Built-in adapter (Shopee, etc.).
 *   3. null — content script bails.
 *
 * The user-trained adapter wins so users can override our heuristics
 * if they don't like what the built-in adapter masks.
 */
export async function pickAdapter(
  hostname: string,
  origin: string
): Promise<SiteAdapter | null> {
  const userConfig = await getConfig(origin);
  if (userConfig?.cardSelector) {
    return buildUserAdapter(userConfig);
  }
  for (const adapter of BUILT_IN_ADAPTERS) {
    if (adapter.matches(hostname)) return adapter;
  }
  return null;
}

export { shopeeAdapter };
