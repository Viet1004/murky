import { Scorer, ScoringContext, MaskDecision } from "../types";

/**
 * "Pre-trained" by hand: simple rules over title keywords + budget.
 * Synchronous, zero dependencies — ships day one and acts as the fallback
 * while heavier scorers warm up.
 *
 * Decision: mask = NOT in user's focus.
 *  - blockedKeywords match → always mask
 *  - focusKeywords match    → never mask
 *  - over budget            → mask
 *  - prompt token overlap   → keep (mask if zero overlap)
 *  - no prompt set          → never mask (we have nothing to filter on)
 */
export const heuristicScorer: Scorer = {
  id: "heuristic",
  displayName: "Heuristic (keyword + budget)",

  score(ctx: ScoringContext): MaskDecision {
    const title = (ctx.features.title ?? "").toLowerCase();
    const profile = ctx.profile;

    // Hard rules first.
    const blocked = (profile.blockedKeywords ?? []).find((kw) =>
      title.includes(kw.toLowerCase())
    );
    if (blocked) {
      return decision(true, 1, `blocked:${blocked}`);
    }

    const focus = (profile.focusKeywords ?? []).find((kw) =>
      title.includes(kw.toLowerCase())
    );
    if (focus) {
      return decision(false, 0, `focus:${focus}`);
    }

    if (profile.budgetCeilingVnd && ctx.features.price) {
      const priceVnd = parsePriceVnd(ctx.features.price);
      if (priceVnd !== null && priceVnd > profile.budgetCeilingVnd) {
        return decision(true, 0.9, `over-budget:${priceVnd}`);
      }
    }

    const prompt = profile.prompt?.trim();
    if (!prompt) {
      return decision(false, 0, "no-prompt");
    }
    if (!title) {
      return decision(true, 1, "no-title");
    }

    const overlap = tokenOverlap(prompt, title);
    // 0 overlap → fully off-focus → mask. Threshold tuneable later.
    return decision(overlap < 0.15, 1 - overlap, `overlap=${overlap.toFixed(2)}`);
  },
};

function decision(shouldMask: boolean, score: number, reason: string): MaskDecision {
  return { shouldMask, score, reason, modelId: heuristicScorer.id };
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

/** Jaccard-ish: |intersection| / |prompt tokens|. */
function tokenOverlap(prompt: string, title: string): number {
  const p = tokenize(prompt);
  const t = tokenize(title);
  if (p.size === 0) return 0;
  let hits = 0;
  for (const w of p) if (t.has(w)) hits++;
  return hits / p.size;
}

function parsePriceVnd(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  return parseInt(digits, 10);
}
