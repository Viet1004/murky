import { ProductId, ProductFeatures } from "../types";

/**
 * Rules for scraping product features. Each adapter provides its own
 * rules object; the shared scrapeWithRules() function consumes it.
 */
export interface ScrapeRules {
  /** Regex that matches a price string, e.g. /[₫đ]\s?[\d.,]+/ */
  currencyRegex: RegExp;
  /** Regex with one capture group for the sold-count number. */
  soldRegex: RegExp;
  /** Regex that matches a product link URL. */
  productLinkRegex: RegExp;
}

// -------------------------------------------------------------------
// Product ID extraction
// -------------------------------------------------------------------

/**
 * Extract a ProductId from a link using a regex that captures:
 *   group 1 = raw id slug
 *   group 2 = shopId  (optional)
 *   group 3 = itemId  (optional)
 */
export function extractIdFromLink(
  link: HTMLAnchorElement,
  pattern: RegExp
): ProductId | null {
  const match = link.href.match(pattern);
  if (!match) return null;
  return {
    raw: match[1] ?? match[0],
    shopId: match[2] ?? "",
    itemId: match[3] ?? match[2] ?? match[1] ?? "",
  };
}

// -------------------------------------------------------------------
// Feature scraping
// -------------------------------------------------------------------

/**
 * Generic feature scraper driven by adapter-provided rules. Covers the
 * common "class-contains selectors + regex fallback" case. Adapters can
 * override scrapeFeatures entirely if their DOM is too different.
 */
export function scrapeWithRules(
  card: HTMLElement,
  rules: ScrapeRules
): ProductFeatures {
  const priceEl =
    card.querySelector('[class*="price" i]') ??
    card.querySelector('[class*="Price"]');
  const allText = card.textContent ?? "";

  const priceMatch = allText.match(rules.currencyRegex);
  const discountMatch = allText.match(/-?\d+%/);
  const soldMatch = allText.match(rules.soldRegex);

  const ratingEl = card.querySelector('[class*="rating" i]');
  const locationEl = card.querySelector('[class*="location" i]');

  const title = findTitleText(card, rules.currencyRegex);

  const imgEl = card.querySelector<HTMLImageElement>("img");

  const originalPriceEl = card.querySelector(
    '[class*="original" i], [class*="before" i], s, del'
  );
  const originalPriceMatch = originalPriceEl?.textContent?.match(
    /[₫đ$€£¥]?\s?[\d.,]+/
  );

  return {
    title,
    price: priceEl?.textContent?.trim() ?? priceMatch?.[0] ?? null,
    originalPrice: originalPriceMatch?.[0]?.trim() ?? null,
    discount: discountMatch?.[0] ?? null,
    rating: ratingEl?.textContent?.trim() ?? null,
    soldCount: soldMatch?.[1] ?? null,
    location: locationEl?.textContent?.trim() ?? null,
    imageUrl: imgEl?.src ?? imgEl?.dataset.src ?? null,
  };
}

/**
 * Heuristic title finder for sites (like Shopee) that use generated class
 * names. Strategy:
 *   1) Try class-contains on "name"/"title".
 *   2) Walk every element inside the product link and pick the "deepest"
 *      container with substantive text — i.e., one whose children do NOT
 *      each carry essentially the same text. This naturally descends past
 *      wrappers (the whole card, the link) and lands on the actual title
 *      container, without false-negatives from inline images/badges.
 */
function norm(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ");
}

function isTitleLike(text: string, currencyRegex: RegExp): boolean {
  if (text.length < 8 || text.length > 500) return false;
  if (currencyRegex.test(text)) return false;
  if (/^-?\d+%$/.test(text)) return false;
  if (!/\p{L}{3,}/u.test(text)) return false;
  return true;
}

function findTitleText(
  card: HTMLElement,
  currencyRegex: RegExp
): string | null {
  // 1) Class-based match (works on sites with semantic class names)
  const byClass = card.querySelector<HTMLElement>(
    '[class*="name" i], [class*="title" i]'
  );
  const byClassText = norm(byClass?.textContent);
  if (byClassText.length >= 8) return byClassText;

  // 2) Heuristic fallback
  const link = card.querySelector<HTMLAnchorElement>("a[href]");
  const root: HTMLElement = link ?? card;

  let best: string | null = null;
  let bestLen = 0;

  const all = root.querySelectorAll<HTMLElement>("*");
  for (const el of all) {
    const text = norm(el.textContent);
    if (!isTitleLike(text, currencyRegex)) continue;

    // Skip ancestors whose text is essentially carried by a single child —
    // we want the deepest element that still owns this text.
    let carriedByChild = false;
    for (const child of Array.from(el.children)) {
      const ct = norm(child.textContent);
      if (ct.length >= text.length * 0.9) {
        carriedByChild = true;
        break;
      }
    }
    if (carriedByChild) continue;

    // Among the deepest candidates, pick the longest one.
    if (text.length > bestLen) {
      bestLen = text.length;
      best = text;
    }
  }

  return best;
}

// -------------------------------------------------------------------
// Sub-element locators (default implementations)
// -------------------------------------------------------------------

/**
 * Default image locator: prefer <picture>, then a class-contains match,
 * then walk up from <img>. Works on most e-commerce sites.
 */
export function defaultFindImageElement(
  card: HTMLElement
): HTMLElement | null {
  const picture = card.querySelector<HTMLElement>("picture");
  if (picture) return picture;

  const byClass = card.querySelector<HTMLElement>(
    '[class*="image" i], [class*="Image"], [class*="cover" i]'
  );
  if (byClass) return byClass;

  const img = card.querySelector<HTMLImageElement>("img");
  if (!img) return null;

  let el: HTMLElement | null = img;
  for (let i = 0; i < 3; i++) {
    if (!el.parentElement) break;
    el = el.parentElement;
  }
  return el ?? img;
}

/**
 * Default discount locator: class-contains selectors first, then a
 * text-based fallback that finds the smallest element whose text
 * matches a percentage pattern like "-50%".
 */
export function defaultFindDiscountElement(
  card: HTMLElement
): HTMLElement | null {
  const byClass = card.querySelector<HTMLElement>(
    '[class*="discount" i], [class*="percent" i], [class*="sale" i], [class*="promo" i], [class*="badge" i]'
  );
  if (byClass) return byClass;

  const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT);
  let best: HTMLElement | null = null;
  let bestArea = Infinity;
  let node = walker.nextNode() as HTMLElement | null;
  while (node) {
    const text = (node.textContent ?? "").trim();
    if (/^-?\d+%$/.test(text)) {
      const rect = node.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > 0 && area < bestArea) {
        bestArea = area;
        best = node;
      }
    }
    node = walker.nextNode() as HTMLElement | null;
  }
  return best;
}

/**
 * Default description locator: class-contains match on "name"/"title",
 * otherwise the longest text-only element inside the product link.
 */
export function defaultFindDescriptionElement(
  card: HTMLElement
): HTMLElement | null {
  const byClass = card.querySelector<HTMLElement>(
    '[class*="name" i], [class*="title" i]'
  );
  if (byClass) return byClass;

  const link = card.querySelector<HTMLAnchorElement>("a[href]");
  if (!link) return null;

  let best: HTMLElement | null = null;
  let bestLen = 0;
  const walker = document.createTreeWalker(link, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode() as HTMLElement | null;
  while (node) {
    const text = (node.textContent ?? "").trim();
    if (text.length > bestLen && !node.querySelector("img")) {
      bestLen = text.length;
      best = node;
    }
    node = walker.nextNode() as HTMLElement | null;
  }
  return best;
}

// -------------------------------------------------------------------
// Card detection fallback
// -------------------------------------------------------------------

/**
 * Generic "walk up from product-like links" fallback. Adapters pass a
 * regex that matches their product link format; this walks up each
 * matching link to find the smallest plausible card container.
 */
export function walkUpFromLinks(
  root: ParentNode,
  linkPattern: RegExp
): HTMLElement[] {
  const cards = new Set<HTMLElement>();
  const anchors = root.querySelectorAll<HTMLAnchorElement>("a[href]");

  for (const link of anchors) {
    if (!linkPattern.test(link.href)) continue;

    let container: HTMLElement = link;
    for (let i = 0; i < 5; i++) {
      const parent = container.parentElement;
      if (!parent || parent.tagName === "BODY") break;
      if (parent.children.length > 2 && parent.children.length < 100) {
        cards.add(container);
        break;
      }
      container = parent;
    }
  }

  return Array.from(cards);
}
