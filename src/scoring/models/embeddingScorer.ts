import { Scorer, ScoringContext, MaskDecision } from "../types";
import { timings } from "../timings";

/**
 * Sentence-embedding scorer using @xenova/transformers (MiniLM-L6-v2,
 * ~25 MB quantized). Loaded lazily on first use; weights cache in the
 * Cache Storage API so subsequent page loads are instant.
 *
 * Decision: cosine(embed(prompt), embed(title)) — mask when below threshold.
 *
 * Behavior while warming up: returns shouldMask=false with reason
 * "model-loading" (fail open) so the page isn't blocked. Callers MUST
 * NOT mark such cards as permanently processed — when the model
 * finishes loading, `onModelReady` fires and the content script
 * should re-score those deferred cards.
 *
 * Status tracking: each transition is mirrored to chrome.storage.local
 * under MODEL_STATUS_KEY so the popup can show "Downloading… 12 MB" /
 * "Ready (23 MB)" / "Failed" badges.
 */

type Pipeline = (
  text: string | string[],
  opts?: { pooling?: "mean" | "cls"; normalize?: boolean }
) => Promise<{ data: Float32Array }>;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_THRESHOLD = 0.75;
const DEFAULT_AVOID_THRESHOLD = 0.6;
const MODEL_STATUS_KEY = "murkyEmbeddingModelStatus";

export type EmbeddingModelStatus =
  | "not-loaded"
  | "loading"
  | "ready"
  | "error";

export interface EmbeddingModelStatusRecord {
  status: EmbeddingModelStatus;
  /** Bytes downloaded so far (during loading) or total size (when ready). */
  bytes: number;
  /** Last update wall-clock time. */
  updatedAt: number;
  /** Error message when status === "error". */
  error?: string;
}

let extractor: Pipeline | null = null;
let loadingPromise: Promise<void> | null = null;
let focusPromptCache: { text: string; vec: Float32Array } | null = null;
let avoidPromptCache: { text: string; vec: Float32Array } | null = null;
let onReadyCallbacks: Array<() => void> = [];
let currentStatus: EmbeddingModelStatusRecord = {
  status: "not-loaded",
  bytes: 0,
  updatedAt: Date.now(),
};

function setStatus(next: Partial<EmbeddingModelStatusRecord>): void {
  currentStatus = { ...currentStatus, ...next, updatedAt: Date.now() };
  // Mirror to chrome.storage.local so the popup can render a badge
  // without having to reach into the content-script context.
  try {
    chrome.storage.local.set({ [MODEL_STATUS_KEY]: currentStatus });
  } catch {
    /* Not in an extension context (e.g. unit test) — silently ignore. */
  }
}

export function getModelStatus(): EmbeddingModelStatusRecord {
  return currentStatus;
}

/**
 * Force-load the model. Useful for the popup's "Download now" button so
 * the user can pre-warm before browsing instead of waiting on the first
 * scored page. Returns when load completes (or rejects on error).
 */
export async function preloadEmbeddingModel(): Promise<void> {
  await ensureLoaded();
}

async function ensureLoaded(): Promise<void> {
  if (extractor) return;
  if (loadingPromise) return loadingPromise;
  setStatus({ status: "loading", bytes: 0, error: undefined });
  loadingPromise = (async () => {
    try {
      // Dynamic import keeps the heavy lib out of the cold-start path.
      const transformers = await import("@xenova/transformers");
      transformers.env.allowLocalModels = false;
      transformers.env.useBrowserCache = true;
      // Track bytes per file as they download. Xenova fires
      // progress events with { status, file, loaded, total, progress }.
      const fileTotals = new Map<string, number>();
      extractor = (await transformers.pipeline(
        "feature-extraction",
        MODEL_ID,
        {
          progress_callback: (p: {
            status?: string;
            file?: string;
            loaded?: number;
            total?: number;
          }) => {
            if (!p.file) return;
            if (typeof p.loaded === "number") {
              fileTotals.set(p.file, p.loaded);
              let sum = 0;
              for (const v of fileTotals.values()) sum += v;
              setStatus({ status: "loading", bytes: sum });
            }
          },
        }
      )) as unknown as Pipeline;
      // Final size = sum of all completed files.
      let totalBytes = 0;
      for (const v of fileTotals.values()) totalBytes += v;
      setStatus({ status: "ready", bytes: totalBytes });
      for (const cb of onReadyCallbacks) {
        try { cb(); } catch { /* ignore */ }
      }
      onReadyCallbacks = [];
    } catch (err) {
      setStatus({ status: "error", error: String(err) });
      loadingPromise = null;
      throw err;
    }
  })();
  return loadingPromise;
}

async function embed(text: string): Promise<Float32Array> {
  if (!extractor) throw new Error("model not loaded");
  return timings.measure("embed", async () => {
    const out = await extractor!(text, { pooling: "mean", normalize: true });
    return out.data;
  });
}

function cosine(a: Float32Array, b: Float32Array): number {
  // Both vectors are L2-normalized → dot product = cosine.
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Tokenize text into a set of lowercased length>2 word tokens. Identical to
 * the heuristic scorer's tokenizer — we duplicate locally rather than
 * coupling the two modules over three lines.
 */
function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

/** First token of `prompt` that appears in the lowercased `title`, else null. */
function firstTokenHit(prompt: string, title: string): string | null {
  const titleTokens = tokenize(title);
  for (const tok of tokenize(prompt)) {
    if (titleTokens.has(tok)) return tok;
  }
  return null;
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
    const focusPrompt = ctx.profile.prompt?.trim();
    const avoidPrompt = ctx.profile.avoidPrompt?.trim();
    const title = ctx.features.title?.trim();

    if (!focusPrompt && !avoidPrompt) {
      return { shouldMask: false, score: 0, reason: "no-prompt", modelId: this.id };
    }
    if (!title) {
      // No title to score against: if the user set a focus we mask
      // defensively (we can't tell whether the product fits); if they
      // only set an avoid we leave it alone (no signal it matches).
      const mask = Boolean(focusPrompt);
      return { shouldMask: mask, score: mask ? 1 : 0, reason: "no-title", modelId: this.id };
    }

    // Lexical pre-check. MiniLM-L6-v2 is English-trained and produces
    // low-similarity scores for non-English text (e.g. Vietnamese "Đèn
    // LED" vs "Đèn LED siêu sáng" hovers well below the avoid threshold),
    // so a literal token match short-circuits the embedding. Avoid wins
    // over focus when both hit, mirroring the cosine path below.
    const avoidHit = avoidPrompt ? firstTokenHit(avoidPrompt, title) : null;
    if (avoidHit) {
      return { shouldMask: true, score: 1, reason: `avoid-keyword:${avoidHit}`, modelId: this.id };
    }
    const focusHit = focusPrompt ? firstTokenHit(focusPrompt, title) : null;
    if (focusHit) {
      return { shouldMask: false, score: 0, reason: `focus-keyword:${focusHit}`, modelId: this.id };
    }

    // Kick off load on first call. Mask defensively-OFF until ready so
    // we don't hide everything during the 2–5 s warm-up.
    if (!extractor) {
      ensureLoaded().catch((e) => console.warn("[murky] embedding load failed", e));
      return { shouldMask: false, score: 0, reason: "model-loading", modelId: this.id };
    }

    const titleVec = await embed(title);
    const focusThreshold = (ctx.config.threshold as number | undefined) ?? DEFAULT_THRESHOLD;
    const avoidThreshold =
      (ctx.config.avoidThreshold as number | undefined) ?? DEFAULT_AVOID_THRESHOLD;

    let simFocus: number | null = null;
    if (focusPrompt) {
      if (!focusPromptCache || focusPromptCache.text !== focusPrompt) {
        focusPromptCache = { text: focusPrompt, vec: await embed(focusPrompt) };
      }
      simFocus = timings.measureSync("cosine", () =>
        cosine(focusPromptCache!.vec, titleVec)
      );
    }

    let simAvoid: number | null = null;
    if (avoidPrompt) {
      if (!avoidPromptCache || avoidPromptCache.text !== avoidPrompt) {
        avoidPromptCache = { text: avoidPrompt, vec: await embed(avoidPrompt) };
      }
      simAvoid = timings.measureSync("cosine", () =>
        cosine(avoidPromptCache!.vec, titleVec)
      );
    }

    const offFocus = simFocus !== null && simFocus < focusThreshold;
    const hitsAvoid = simAvoid !== null && simAvoid > avoidThreshold;
    const shouldMask = offFocus || hitsAvoid;

    const focusScore = simFocus !== null ? 1 - simFocus : 0;
    const avoidScore = simAvoid !== null ? simAvoid : 0;
    const score = Math.max(focusScore, avoidScore);

    const parts: string[] = [];
    if (simFocus !== null) parts.push(`focus=${simFocus.toFixed(3)}/thr=${focusThreshold}`);
    if (simAvoid !== null) parts.push(`avoid=${simAvoid.toFixed(3)}/thr=${avoidThreshold}`);
    return {
      shouldMask,
      score,
      reason: parts.join(" "),
      modelId: this.id,
    };
  },
};
