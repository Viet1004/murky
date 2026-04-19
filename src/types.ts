/** Identifies a product on Shopee, extracted from URL pattern: name-i.{shopId}.{itemId} */
export interface ProductId {
  raw: string;        // full match e.g. "ao-thun-nam-i.123.456"
  shopId: string;
  itemId: string;
}

/** Product features scraped from the card DOM */
export interface ProductFeatures {
  title: string | null;
  price: string | null;
  originalPrice: string | null;
  discount: string | null;
  rating: string | null;
  soldCount: string | null;
  location: string | null;
  imageUrl: string | null;
}

/** A single interaction event for data collection */
export interface InteractionEvent {
  siteId: string;                  // which e-commerce site this came from
  productId: ProductId;
  features: ProductFeatures;
  wasMasked: boolean;
  unmaskedAt: number | null;       // timestamp when user revealed the product
  clickedAt: number | null;        // timestamp when user clicked through to the product
  remaskAt: number | null;         // timestamp if user re-masked without clicking
  pageUrl: string;
  sessionId: string;
  timestamp: number;               // when the product was first seen
}

/** Stored collection data */
export interface CollectionData {
  events: InteractionEvent[];
  sessionCount: number;
}

/**
 * Granularity of masking:
 *  - "full"     → covers the whole product card
 *  - "image"    → covers only the product image
 *  - "discount" → covers only the discount badge
 */
export type MaskLevel = "full" | "image" | "discount";

/** Storage schema */
export interface MurkyStorage {
  murkyEnabled: boolean;
  murkyRevealed: string[];
  murkyCollection: CollectionData;
  murkyMaskLevel: MaskLevel;
}
