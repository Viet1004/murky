/**
 * Per-origin storage of user-picked selectors. One config per origin;
 * picking again overwrites. Read in the content script to build a
 * `userAdapter`, written by the picker overlay on confirmation.
 */

const STORE_KEY = "murkySiteSelectors";

export interface SiteSelectorConfig {
  /** ECMA-style origin: "https://www.youtube.com" */
  origin: string;
  /** CSS selector that matches every "card" / "tile" / "post" on the site. */
  cardSelector: string;
  /** Optional override for the link inside the card. */
  hrefSelector?: string;
  /** Optional override for the image inside the card. */
  imageSelector?: string;
  /** Optional override for the title inside the card. */
  titleSelector?: string;
  /** Optional override for the price inside the card (e-commerce). */
  priceSelector?: string;
  /** Friendly name shown in the popup ("YouTube watch tiles"). */
  label?: string;
  /** ms since epoch — for stale-config detection. */
  savedAt: number;
}

export type SiteSelectorStore = Record<string, SiteSelectorConfig>;

export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return "";
  }
}

export async function loadStore(): Promise<SiteSelectorStore> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORE_KEY], (r) => {
      resolve((r[STORE_KEY] as SiteSelectorStore | undefined) ?? {});
    });
  });
}

export async function getConfig(origin: string): Promise<SiteSelectorConfig | null> {
  const store = await loadStore();
  return store[origin] ?? null;
}

export async function saveConfig(config: SiteSelectorConfig): Promise<void> {
  const store = await loadStore();
  store[config.origin] = config;
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORE_KEY]: store }, () => resolve());
  });
}

export async function deleteConfig(origin: string): Promise<void> {
  const store = await loadStore();
  delete store[origin];
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORE_KEY]: store }, () => resolve());
  });
}

export async function listOrigins(): Promise<string[]> {
  const store = await loadStore();
  return Object.keys(store);
}
