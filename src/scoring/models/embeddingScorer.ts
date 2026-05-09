import { Scorer, ScoringContext, MaskDecision } from "../types";

/**
 * Sentence-embedding scorer using @xenova/transformers (MiniLM-L6-v2,
 * ~25 MB quantized). Loaded lazily on first use; weights cache in
 * IndexedDB so subsequent page loads are fast.
 *
 * Decision: cosine(embed(prompt), embed(title)) — mask when below threshold.
 *
 * Behavior while warming up: returns shouldMask=false (fail open) so the
 * page isn't blocked. Caller can re-process cards once the model is ready
 * — see `onReady`.
 */

type Pipeline = (
  text: string | string[],
  opts?: { pooling?: "mean" | "cls"; normalize?: boolean }
) => Promise<{ data: Float32Array }>;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_THRESHOLD = 0.35;

let extractor: Pipeline | null = null;
let loadingPromise: Promise<void> | null = null;
let promptCache: { text: string; vec: Float32Array } | null = null;
let onReadyCallbacks: Array<() => void> = [];

async function ensureLoaded(): Promise<void> {
  if (extractor) return;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    // Dynamic import keeps the heavy lib out of the cold-start path.
    const transformers = await import("@xenova/transformers");
    transformers.env.allowLocalModels = false;
    transformers.env.useBrowserCache = true;
    extractor = (await transformers.pipeline(
      "feature-extraction",
      MODEL_ID
    )) as unknown as Pipeline;
    for (const cb of onReadyCallbacks) {
      try { cb(); } catch { /* ignore */ }
    }
    onReadyCallbacks = [];
  })();
  return loadingPromise;
}

async function embed(text: string): Promise<Float32Array> {
  if (!extractor) throw new Error("model not loaded");
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return out.data;
}

function cosine(a: Float32Array, b: Float32Array): number {
  // Both vectors are L2-normalized → dot product = cosine.
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/** Register a callback to fire once the model finishes loading. */
export function onModelReady(cb: () => void): void {
  if (extractor) {
    cb();
  } else {
    onReadyCallbacks.push(cb);
  }
}

export const embeddingScorer: Scorer = {
  id: "embedding-minilm",
  displayName: "MiniLM embedding (focus matching)",

  async score(ctx: ScoringContext): Promise<MaskDecision> {
    const prompt = ctx.profile.prompt?.trim();
    const title = ctx.features.title?.trim();

    if (!prompt) {
      return { shouldMask: false, score: 0, reason: "no-prompt", modelId: this.id };
    }
    if (!title) {
      return { shouldMask: true, score: 1, reason: "no-title", modelId: this.id };
    }

    // Kick off load on first call. Mask defensively-OFF until ready so
    // we don't hide everything during the 2–5 s warm-up.
    if (!extractor) {
      ensureLoaded().catch((e) => console.warn("[murky] embedding load failed", e));
      return { shouldMask: false, score: 0, reason: "model-loading", modelId: this.id };
    }

    if (!promptCache || promptCache.text !== prompt) {
      promptCache = { text: prompt, vec: await embed(prompt) };
    }
    const titleVec = await embed(title);
    const sim = cosine(promptCache.vec, titleVec);
    const threshold = (ctx.config.threshold as number | undefined) ?? DEFAULT_THRESHOLD;

    return {
      shouldMask: sim < threshold,
      score: 1 - sim,
      reason: `cos=${sim.toFixed(3)} thr=${threshold}`,
      modelId: this.id,
    };
  },
};
