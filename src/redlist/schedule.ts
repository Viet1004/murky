/**
 * Pure functions for red-list matching. No DOM, no storage, no chrome
 * APIs — easy to unit test in isolation later.
 */

import type { RedListEntry, RedListWindow } from "./types";

/**
 * Does `hostname` match `pattern`?
 *
 * Match if equal OR if hostname ends with ".${pattern}". Plain substring
 * matching is intentionally avoided — see the rationale on
 * RedListEntry.hostnamePattern.
 */
export function hostnameMatches(hostname: string, pattern: string): boolean {
  if (!hostname || !pattern) return false;
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase().replace(/^www\./, "");
  return h === p || h.endsWith(`.${p}`);
}

/** Convert a Date to "minutes since 00:00 local". */
function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function windowStartMin(w: RedListWindow): number {
  return w.startHour * 60 + w.startMinute;
}

function windowEndMin(w: RedListWindow): number {
  return w.endHour * 60 + w.endMinute;
}

/**
 * Is `now` inside the window?
 *
 * Handles two cases:
 *  - Same-day window (start < end): standard interval check.
 *  - Cross-midnight window (start > end), e.g. 22:00 → 02:00. Active
 *    if now ≥ start OR now < end. We DON'T currently flip the day-of-week
 *    check for the late-night side; the entry's daysOfWeek refers to
 *    the day the window starts.
 *
 * `start == end` is treated as never-active (zero-length window) rather
 * than always-active, to avoid silent "I made a typo and now nothing
 * works" footguns.
 */
export function windowActive(now: Date, w: RedListWindow): boolean {
  if (w.daysOfWeek && w.daysOfWeek.length > 0 && !w.daysOfWeek.includes(now.getDay())) {
    return false;
  }
  const cur = minutesOfDay(now);
  const start = windowStartMin(w);
  const end = windowEndMin(w);
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  // Cross-midnight.
  return cur >= start || cur < end;
}

/**
 * Format the end of the currently-active window as a short human
 * string, e.g. "5:00 PM" or "tomorrow 2:00 AM" for cross-midnight.
 * Used in the overlay copy ("blocked until …").
 */
export function formatWindowEnd(now: Date, w: RedListWindow): string {
  const end = new Date(now);
  end.setSeconds(0, 0);
  end.setHours(w.endHour, w.endMinute, 0, 0);
  if (windowStartMin(w) > windowEndMin(w) && minutesOfDay(now) >= windowStartMin(w)) {
    // Cross-midnight, currently in the pre-midnight half.
    end.setDate(end.getDate() + 1);
  }
  return end.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Find the first enabled entry that matches this hostname AND has an
 * active window right now. Returns null if nothing matches.
 */
export function findActiveBlock(
  hostname: string,
  entries: RedListEntry[],
  now: Date = new Date()
): { entry: RedListEntry; window: RedListWindow } | null {
  for (const entry of entries) {
    if (!entry.enabled) continue;
    if (!hostnameMatches(hostname, entry.hostnamePattern)) continue;
    for (const w of entry.windows) {
      if (windowActive(now, w)) return { entry, window: w };
    }
  }
  return null;
}
