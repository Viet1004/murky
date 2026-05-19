/**
 * Red-list of websites to block on a schedule.
 *
 * Conceptually distinct from the universal picker: the picker hides
 * *elements within* a site, the red-list covers the *whole page* during
 * a time window. Different layer of the masking story, same opt-in.
 */

export interface RedListWindow {
  /** Start of the window, local time, 0-23. */
  startHour: number;
  /** 0-59. */
  startMinute: number;
  /** End of the window, local time, 0-23. */
  endHour: number;
  /** 0-59. */
  endMinute: number;
  /**
   * Days of the week the window applies to. 0=Sunday … 6=Saturday.
   * `undefined` means every day (V1 default).
   */
  daysOfWeek?: number[];
}

export interface RedListEntry {
  /** Stable id, useful for edit/delete in the popup list. */
  id: string;
  /**
   * Hostname pattern. Matches if the navigation URL's hostname is
   * exactly this value OR ends with `.${value}`. So "facebook.com"
   * matches `facebook.com`, `www.facebook.com`, `m.facebook.com`.
   * Plain substring matching ("Facebook") is intentionally not
   * supported — too easy to over-match (e.g. blocks news articles
   * about Facebook).
   */
  hostnamePattern: string;
  /** Optional friendly name shown in the popup ("Social media block"). */
  label?: string;
  /** V1 supports exactly one window per entry; modeling as array
   * leaves room for "weekday 9-5 and weekend 10-12" without a future
   * migration. */
  windows: RedListWindow[];
  /** Soft toggle in the popup; cheaper than deleting + re-adding. */
  enabled: boolean;
  /** ms since epoch — for sort order in the popup. */
  createdAt: number;
}

export interface RedListBypass {
  /** Matches the entry's hostnamePattern. */
  hostnamePattern: string;
  /** ms since epoch — past this, the bypass is no longer honored. */
  expiresAt: number;
}

/**
 * Storage key in chrome.storage.local for the list of entries.
 * Bypasses live in a separate key so a hot edit to the list doesn't
 * race with bypass writes.
 */
export const RED_LIST_KEY = "murkyRedList";
export const RED_LIST_BYPASS_KEY = "murkyRedListBypasses";
