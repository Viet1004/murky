import { ProductFeatures, ProductId } from "../types";

/**
 * What the user wants to focus on. Lives in chrome.storage.local under
 * "murkyProfile". A product is masked when it does NOT fit this focus.
 */
export interface UserProfile {
  /** Free-text description of what the user wants to see (the focus). */
  prompt?: string;
  /** Hard-block keywords — title containing any of these always masks. */
  blockedKeywords?: string[];
  /** Hard-allow keywords — title containing any of these never masks. */
  focusKeywords?: string[];
  /** Maximum price in VND; products above are masked regardless of relevance. */
  budgetCeilingVnd?: number;
}

/** Per-scorer config bag (scorer-specific, free-form). */
export type ScorerConfig = Record<string, unknown>;

export interface ScoringContext {
  productId: ProductId | null;
  features: ProductFeatures;
  profile: UserProfile;
  config: ScorerConfig;
  pageUrl: string;
}

export interface MaskDecision {
  /** True → this product gets a mask. */
  shouldMask: boolean;
  /** 0..1 — probability that the product should be masked (1 = definitely mask). */
  score: number;
  /** Short human-readable reason for debugging. */
  reason: string;
  /** Which scorer made the call. */
  modelId: string;
}

export interface Scorer {
  readonly id: string;
  readonly displayName: string;
  /**
   * Decide whether to mask. May be sync or async — the caller awaits.
   * Async scorers should fail open (return shouldMask=false) while warming up
   * rather than blocking the page.
   */
  score(ctx: ScoringContext): Promise<MaskDecision> | MaskDecision;
}
