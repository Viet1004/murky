import { ProductId, ProductFeatures } from "../types";

/**
 * A SiteAdapter encapsulates everything that is specific to one
 * e-commerce site. The content script is 100% site-agnostic and
 * delegates all site-specific questions to the adapter for the
 * current page.
 *
 * Adding a new site = writing one new file implementing this interface
 * and registering it in src/adapters/index.ts.
 */
export interface SiteAdapter {
  /** Stable identifier used in telemetry and the event schema. */
  readonly siteId: string;

  /** Human-readable name for UI display. */
  readonly displayName: string;

  /** ISO currency code (e.g., "VND", "USD", "THB"). */
  readonly currency: string;

  /** BCP-47 locale (e.g., "vi-VN", "en-US"). */
  readonly locale: string;

  /**
   * Returns true if this adapter should handle a page on the given
   * hostname. Called once at content script startup.
   */
  matches(hostname: string): boolean;

  /** CSS selectors that locate product cards on listing pages. */
  readonly cardSelectors: string[];

  /**
   * Optional fallback used when cardSelectors return nothing. Should
   * walk the DOM heuristically to find cards (e.g., via known URL
   * patterns). Adapters that don't need a fallback can omit this.
   */
  fallbackFindCards?(root: ParentNode): HTMLElement[];

  /**
   * Extract a structured product ID from a product link. Return null
   * if the link doesn't look like a product URL for this site.
   */
  extractProductId(link: HTMLAnchorElement): ProductId | null;

  /** Scrape feature values (title, price, discount, ...) from a card. */
  scrapeFeatures(card: HTMLElement): ProductFeatures;

  /** Locate the image sub-element inside a card. */
  findImageElement(card: HTMLElement): HTMLElement | null;

  /** Locate the discount badge sub-element inside a card. */
  findDiscountElement(card: HTMLElement): HTMLElement | null;

  /** Locate the title/description sub-element inside a card. */
  findDescriptionElement(card: HTMLElement): HTMLElement | null;
}
