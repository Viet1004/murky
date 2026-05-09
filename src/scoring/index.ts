/**
 * Scoring module: decides which products to mask.
 *
 * Add a new model:
 *   1. Create src/scoring/models/yourScorer.ts implementing `Scorer`.
 *   2. Import + register() it below.
 *   3. Set chrome.storage.local["murkyScorerId"] = "your-id" to activate.
 */

import { register, get, list } from "./registry";
import { randomScorer } from "./models/randomScorer";
import { heuristicScorer } from "./models/heuristicScorer";
import { embeddingScorer, onModelReady } from "./models/embeddingScorer";
import { getProfile, getScorerId, getScorerConfig, DEFAULT_SCORER_ID } from "./storage";
import { Scorer, ScoringContext, MaskDecision, UserProfile } from "./types";


let initialized = false;

export function initRegistry(): void {
  if (initialized) return;
  register(randomScorer);
  register(heuristicScorer);
  register(embeddingScorer);
  initialized = true;
}

/** Resolve the active scorer (falls back to random if id is unknown). */
export async function getActiveScorer(): Promise<Scorer> {
  initRegistry();
  const id = await getScorerId();
  return get(id) ?? get(DEFAULT_SCORER_ID) ?? randomScorer;
}

export {
  list as listScorers,
  getProfile,
  getScorerId,
  getScorerConfig,
  onModelReady,
};
export type { Scorer, ScoringContext, MaskDecision, UserProfile };
