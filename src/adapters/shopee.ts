import { SiteAdapter } from "./types";
import {
  ScrapeRules,
  extractIdFromLink,
  scrapeWithRules,
  defaultFindImageElement,
  defaultFindDiscountElement,
  defaultFindDescriptionElement,
  walkUpFromLinks,
} from "./utils";

/**
 * URL patterns Shopee uses (must also be in manifest.json):
 *   *://shopee.vn/*
 *   *://shopee.sg/*
 *   *://shopee.co.th/*
 *   *://shopee.com.my/*
 *   *://shopee.ph/*
 *   *://shopee.co.id/*
 *   *://shopee.com.br/*
 */

const SHOPEE_HOSTS = [
  "shopee.vn",
  "shopee.sg",
  "shopee.co.th",
  "shopee.com.my",
  "shopee.ph",
  "shopee.co.id",
  "shopee.com.br",
];

// Shopee product URLs look like: /<slug>-i.<shopId>.<itemId>
const SHOPEE_PRODUCT_LINK_REGEX = /\/([\w%-]+-i\.(\d+)\.(\d+))/;

const SHOPEE_RULES: ScrapeRules = {
  currencyRegex: /[₫đ]\s?[\d.,]+/,
  soldRegex: /(?:Đã bán|sold)\s*([\d.,]+[kK]?)/i,
  productLinkRegex: SHOPEE_PRODUCT_LINK_REGEX,
};

export const shopeeAdapter: SiteAdapter = {
  siteId: "shopee",
  displayName: "Shopee",
  currency: "VND",
  locale: "vi-VN",

  matches(hostname) {
    return SHOPEE_HOSTS.some((h) => hostname === h || hostname.endsWith("." + h));
  },

  cardSelectors: [
    'div[data-sqe="item"]',
    "li.shopee-search-item-result__item",
    ".shopee-search-item-result__item",
    'a[data-sqe="link"]',
    ".shop-search-result-view__item",
    ".stardust-tabs-panels__panel .home-product .shopee-card-atelier-overlay",
  ],

  fallbackFindCards(root) {
    return walkUpFromLinks(root, /-i\.\d+\.\d+/);
  },

  extractProductId(link) {
    return extractIdFromLink(link, SHOPEE_PRODUCT_LINK_REGEX);
  },

  scrapeFeatures(card) {
    return scrapeWithRules(card, SHOPEE_RULES);
  },

  findImageElement: defaultFindImageElement,
  findDiscountElement: defaultFindDiscountElement,
  findDescriptionElement: defaultFindDescriptionElement,
};
