import { Scorer, ScoringContext, MaskDecision } from "../types";

/**
 * "Pre-trained" by hand: simple rules over title keywords + budget.
 * Synchronous, zero dependencies — ships day one and acts as the fallback
 * while heavier scorers warm up.
 *
 * Decision: mask = NOT in user's focus OR matches user's avoid prompt.
 *  - blockedKeywords match    → always mask
 *  - focusKeywords match      → never mask
 *  - over budget              → mask
 *  - avoid prompt token hit   → mask (any title token overlaps the avoid prompt)
 *  - focus prompt no overlap  → mask (title doesn't touch the focus topic)
 *  - neither prompt set       → never mask
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

    const focusPrompt = profile.prompt?.trim();
    const avoidPrompt = profile.avoidPrompt?.trim();
    if (!focusPrompt && !avoidPrompt) {
      return decision(false, 0, "no-prompt");
    }
    if (!title) {
      // No title: only mask defensively when there's a focus we want to verify.
      return decision(Boolean(focusPrompt), focusPrompt ? 1 : 0, "no-title");
    }

    const avoidOverlap = avoidPrompt ? tokenOverlap(avoidPrompt, title) : 0;
    const focusOverlap = focusPrompt ? tokenOverlap(focusPrompt, title) : 1;

    const hitsAvoid = avoidPrompt ? avoidOverlap > 0 : false;
    const offFocus = focusPrompt ? focusOverlap < 0.15 : false;
    const shouldMask = hitsAvoid || offFocus;
    const score = Math.max(avoidOverlap, 1 - focusOverlap);

    const parts: string[] = [];
    if (focusPrompt) parts.push(`focus=${focusOverlap.toFixed(2)}`);
    if (avoidPrompt) parts.push(`avoid=${avoidOverlap.toFixed(2)}`);
    return decision(shouldMask, score, parts.join(" "));
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
