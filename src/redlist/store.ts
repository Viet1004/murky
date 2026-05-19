/**
 * chrome.storage wrappers for the red list + bypass tracking.
 * The popup (write) and background (read) both go through here so the
 * key naming and shape coercion live in exactly one place.
 */

import {
  RED_LIST_KEY,
  RED_LIST_BYPASS_KEY,
  RedListEntry,
  RedListBypass,
} from "./types";

function storageGet<T extends object>(keys: string[]): Promise<T> {
  return new Promise((resolve) =>
    chrome.storage.local.get(keys, (r) => resolve(r as T))
  );
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set(items, () => resolve()));
}

export async function loadEntries(): Promise<RedListEntry[]> {
  const r = await storageGet<{ [RED_LIST_KEY]?: RedListEntry[] }>([RED_LIST_KEY]);
  return r[RED_LIST_KEY] ?? [];
}

export async function saveEntries(entries: RedListEntry[]): Promise<void> {
  await storageSet({ [RED_LIST_KEY]: entries });
}

export async function upsertEntry(entry: RedListEntry): Promise<void> {
  const entries = await loadEntries();
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  await saveEntries(entries);
}

export async function deleteEntry(id: string): Promise<void> {
  const entries = await loadEntries();
  await saveEntries(entries.filter((e) => e.id !== id));
}

// ---- Bypass tracking ------------------------------------------------

/**
 * Bypasses are keyed by hostnamePattern (one bypass per entry, not per
 * tab) so opening 20 tabs of facebook.com after clicking "continue"
 * doesn't require 20 separate bypasses.
 */
export async function loadBypasses(): Promise<Record<string, RedListBypass>> {
  const r = await storageGet<{ [RED_LIST_BYPASS_KEY]?: Record<string, RedListBypass> }>([
    RED_LIST_BYPASS_KEY,
  ]);
  return r[RED_LIST_BYPASS_KEY] ?? {};
}

export async function setBypass(bypass: RedListBypass): Promise<void> {
  const all = await loadBypasses();
  all[bypass.hostnamePattern] = bypass;
  await storageSet({ [RED_LIST_BYPASS_KEY]: all });
}

export async function clearExpiredBypasses(): Promise<void> {
  const all = await loadBypasses();
  const now = Date.now();
  let changed = false;
  for (const k of Object.keys(all)) {
    if (all[k].expiresAt <= now) {
      delete all[k];
      changed = true;
    }
  }
  if (changed) await storageSet({ [RED_LIST_BYPASS_KEY]: all });
}

export function activeBypass(
  hostnamePattern: string,
  bypasses: Record<string, RedListBypass>
): boolean {
  const b = bypasses[hostnamePattern];
  return Boolean(b && b.expiresAt > Date.now());
}

/** Generate a stable id for a new entry. Crypto if available, else timestamp+random. */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
