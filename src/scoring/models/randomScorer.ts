import { Scorer } from "../types";

/** Baseline: 50/50 coin flip. Useful as control for A/B comparison. */
export const randomScorer: Scorer = {
  id: "random",
  displayName: "Random (baseline)",
  score(): { shouldMask: boolean; score: number; reason: string; modelId: string } {
    const r = Math.random();
    return {
      shouldMask: r > 0.5,
      score: r,
      reason: `coin=${r.toFixed(2)}`,
      modelId: this.id,
    };
  },
};
