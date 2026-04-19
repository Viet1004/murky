import { ProductId, ProductFeatures } from "../types";

/**
 * Context passed to a Mask when it's mounted on a product card.
 * The mask uses these callbacks to report user interactions back
 * to the rest of the system (collector, storage, etc.)
 */
export interface MaskContext {
  productId: ProductId | null;
  features: ProductFeatures;

  /** Called when the user has fully revealed the product. */
  onReveal: () => void;

  /** Called when the user re-masks a revealed product. */
  onRemask: () => void;

  /**
   * Called for any interesting interaction (e.g. "first-tap",
   * "puzzle-solved", "video-skipped"). Used by the collector
   * to capture how engaged the user was before unmasking.
   */
  onInteraction: (label: string, payload?: unknown) => void;
}

/**
 * A Mask is a self-contained UI piece that visually covers a product
 * card and handles its own reveal logic. Plug-and-play: the content
 * script doesn't care what's inside.
 */
export interface Mask {
  /** Render the mask DOM into the card. */
  mount(card: HTMLElement, ctx: MaskContext): void;

  /** Tear down the mask DOM. */
  unmount(): void;

  /** Force the mask visible or hidden (e.g. global toggle). */
  setVisible(visible: boolean): void;

  /** Whether the mask is currently revealing the product. */
  isRevealed(): boolean;
}

/**
 * Picks which Mask to use for a given product. Lets you swap strategies
 * (random, price-based, A/B test, user preference, ...).
 */
export interface MaskFactory {
  create(ctx: MaskContext): Mask;
  /** Stable identifier for telemetry: "image", "two-layer", "blur", ... */
  readonly kind: string;
}
