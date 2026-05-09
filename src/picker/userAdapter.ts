/**
 * Generic SiteAdapter built from a user-picked SiteSelectorConfig.
 *
 * Handles arbitrary websites — no site-specific regex. The cardSelector
 * is whatever the picker captured. Features are extracted heuristically:
 *   - title:    longest text-only descendant inside the card
 *   - image:    largest <img> by area
 *   - href:     first <a href> inside the card (or the card itself if <a>)
 *   - price:    first text node matching a generic currency regex
 *
 * Trade-off vs. hand-tuned adapters: less precise per site, but works
 * everywhere without us shipping code per origin.
 */

import { SiteAdapter } from "../adapters/types";
import { ProductId, ProductFeatures } from "../types";
import { SiteSelectorConfig } from "./store";

const GENERIC_CURRENCY_REGEX = /[₫đ$€£¥]\s?[\d.,]+|[\d.,]+\s?(?:VND|USD|EUR|GBP|THB)/i;

function siteIdFor(origin: string): string {
  try {
    const host = new URL(origin).hostname;
    return `picker:${host}`;
  } catch {
    return "picker:unknown";
  }
}

/** Stable-ish hash for an href, used as itemId when site has no ID convention. */
function hashHref(href: string): string {
  let h = 0;
  for (let i = 0; i < href.length; i++) {
    h = (h * 31 + href.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function findHref(card: HTMLElement): HTMLAnchorElement | null {
  if (card.tagName === "A" && (card as HTMLAnchorElement).href) {
    return card as HTMLAnchorElement;
  }
  return card.querySelector<HTMLAnchorElement>("a[href]");
}

function findLargestImage(card: HTMLElement): HTMLImageElement | null {
  const imgs = card.querySelectorAll<HTMLImageElement>("img");
  let best: HTMLImageElement | null = null;
  let bestArea = 0;
  for (const img of imgs) {
    const rect = img.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) {
      bestArea = area;
      best = img;
    }
  }
  return best;
}

/** Longest descendant text that isn't dominated by a single child. */
function findTitleText(card: HTMLElement): string | null {
  let best: string | null = null;
  let bestLen = 0;
  const all = card.querySelectorAll<HTMLElement>("*");
  for (const el of all) {
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
    if (text.length < 8 || text.length > 500) continue;
    if (GENERIC_CURRENCY_REGEX.test(text)) continue;
    let carriedByChild = false;
    for (const child of Array.from(el.children)) {
      const ct = (child.textContent ?? "").trim();
      if (ct.length >= text.length * 0.9) {
        carriedByChild = true;
        break;
      }
    }
    if (carriedByChild) continue;
    if (text.length > bestLen) {
      bestLen = text.length;
      best = text;
    }
  }
  return best;
}

export function buildUserAdapter(config: SiteSelectorConfig): SiteAdapter {
  const id = siteIdFor(config.origin);
  return {
    siteId: id,
    displayName: config.label ?? config.origin,
    currency: "",
    locale: "",

    matches() {
      // The content script only loads this adapter when origin matches,
      // so this always returns true. Origin gating happens at registration.
      return true;
    },

    cardSelectors: [config.cardSelector],

    extractProductId(link: HTMLAnchorElement): ProductId | null {
      const href = link.href;
      if (!href) return null;
      try {
        const u = new URL(href);
        return {
          raw: href,
          shopId: u.hostname,
          itemId: hashHref(u.pathname + u.search),
        };
      } catch {
        return { raw: href, shopId: "", itemId: hashHref(href) };
      }
    },

    scrapeFeatures(card: HTMLElement): ProductFeatures {
      const title = findTitleText(card);
      const img = findLargestImage(card);
      const allText = card.textContent ?? "";
      const priceMatch = allText.match(GENERIC_CURRENCY_REGEX);
      return {
        title,
        price: priceMatch?.[0]?.trim() ?? null,
        originalPrice: null,
        discount: null,
        rating: null,
        soldCount: null,
        location: null,
        imageUrl: img?.src ?? img?.dataset.src ?? null,
      };
    },

    findImageElement(card: HTMLElement): HTMLElement | null {
      return findLargestImage(card);
    },

    findDiscountElement() {
      return null;
    },

    findDescriptionElement(card: HTMLElement): HTMLElement | null {
      // Best-effort: return the first element that owns the title text.
      const title = findTitleText(card);
      if (!title) return null;
      const all = card.querySelectorAll<HTMLElement>("*");
      for (const el of all) {
        if ((el.textContent ?? "").trim().includes(title.slice(0, 40))) {
          return el;
        }
      }
      return null;
    },
  };
}

export { findHref };
