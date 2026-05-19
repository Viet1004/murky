import { ProductId } from "./types";
import { pickAdapter, SiteAdapter } from "./adapters";
import {
  startCollector,
  recordImpression,
  recordUnmask,
  recordRemask,
  recordClick,
} from "./collector";
import {
  initBehaviorCollector,
  recordBehaviorImpression,
  recordBehaviorUnmask,
  recordBehaviorRemask,
  recordBehaviorClick,
} from "./behavior";
import {
  Mask,
  MaskContext,
  MaskRegistry,
  ImageMaskFactory,
  TwoLayerMaskFactory,
  BlurMaskFactory,
  ImageStackMaskFactory,
} from "./masks";
import { loadActiveCollection, CollectionDetail } from "./packs";
import {
  getActiveScorer,
  getProfile,
  getScorerConfig,
  onModelReady,
  preloadEmbeddingModel,
  Scorer,
  UserProfile,
} from "./scoring";
import { decisionCache, makeCacheKey, shortHash } from "./scoring/cache";
import { timings } from "./scoring/timings";

// Expose a preload handle so the popup's "Download now" button (routed
// through background → executeScript) can warm the embedding model
// without waiting for an actual scoring call. No-op outside Chrome.
(window as unknown as {
  __MURKY_PRELOAD_EMBEDDING__?: () => Promise<void>;
}).__MURKY_PRELOAD_EMBEDDING__ = preloadEmbeddingModel;

// --- Pick the adapter for the current site (async — may consult per-origin store) ---
void (async () => {
  const adapter: SiteAdapter | null = await pickAdapter(
    window.location.hostname,
    window.location.origin
  );
  if (!adapter) {
    console.debug("[murky] no adapter for", window.location.hostname);
    return;
  }

  // Gate on the global enable flag before doing anything. If the user has
  // disabled the extension, bail out entirely so the page renders untouched.
  const result = await new Promise<{ [key: string]: unknown }>((resolve) => {
    chrome.storage.local.get(["murkyEnabled"], (r) => resolve(r));
  });
  if (result.murkyEnabled === false) {
    console.debug("[murky] disabled, skipping");
    return;
  }

  // Load the active pack from the server before starting. We block the
  // first scan on this so we don't briefly show local-only masks before
  // the remote ones arrive.
  try {
    const col = await loadActiveCollection();
    await run(adapter, col);
  } catch (e) {
    console.warn("[murky] loadActiveCollection failed, using local fallback", e);
    await run(adapter, null);
  }
})();

function buildRegistry(collection: CollectionDetail | null): MaskRegistry {
  const registry = new MaskRegistry("random");

  if (collection && collection.masks.length > 0) {
    for (const mask of collection.masks) {
      if (mask.type === "image-stack" && mask.layers.length > 0) {
        const urls = mask.layers
          .sort((a, b) => a.position - b.position)
          .map((l) => l.url);
        registry.register(new ImageStackMaskFactory(urls));
      }
      // Future mask types go here:
      // else if (mask.type === "math-equation") { ... }
    }
    if (registry.size > 0) {
      console.debug(
        `[murky] using collection '${collection.slug}': ${collection.masks.length} masks`
      );
      return registry;
    }
  }

  // Local fallback: use the bundled icons.
  const MASK_IMAGE_URL = chrome.runtime.getURL("icons/yao_ming.jpg");
  const MASK_IMAGE_URL_00 = chrome.runtime.getURL("icons/lol_meme.jpg");
  const MASK_IMAGE_URL_01 = chrome.runtime.getURL("icons/y_r_u_g.jpg");
  registry
    .register(new ImageMaskFactory(MASK_IMAGE_URL))
    .register(new TwoLayerMaskFactory(MASK_IMAGE_URL_00, MASK_IMAGE_URL_01))
    .register(new BlurMaskFactory());
  console.debug("[murky] using bundled local masks");
  return registry;
}

async function run(adapter: SiteAdapter, collection: CollectionDetail | null): Promise<void> {
  const registry = buildRegistry(collection);

  // --- State ---
  let revealedCards = new Set<string>();
  const processedCards = new WeakSet<HTMLElement>();
  const maskedCards: Set<HTMLElement> = new Set();
  const cardMasks = new WeakMap<HTMLElement, Mask>();

  // --- Scoring (decides which products to mask) ---
  // Load the scorer + profile + revealed-set BEFORE the first scan.
  // Otherwise cards present at initial paint get processed with a null
  // scorer, marked as processed, and never re-evaluated — only cards
  // added later (via scroll → observer) would ever get masked.
  const [scorerLoaded, profileLoaded, revealed] = await Promise.all([
    getActiveScorer(),
    getProfile(),
    new Promise<string[]>((resolve) => {
      chrome.storage.local.get(["murkyRevealed"], (r) => {
        resolve((r.murkyRevealed as string[] | undefined) ?? []);
      });
    }),
  ]);
  let scorer: Scorer = scorerLoaded;
  let profile: UserProfile = profileLoaded;
  let scorerConfig = await getScorerConfig(scorer.id);
  revealedCards = new Set(revealed);

  // Load the persistent decision cache before the first scan so cache
  // hits can short-circuit slow scorers from the very first card. The
  // promptHash is recomputed whenever the prompt or scorer changes
  // (which naturally invalidates all cache entries because the key
  // includes both).
  void decisionCache.ensureLoaded();
  let promptHash = shortHash((profile.prompt ?? "").trim());

  console.debug("[murky] active scorer:", scorer.id, "profile:", profile);

  onModelReady(() => {
    // Cards seen during model warm-up returned shouldMask=false with
    // reason="model-loading" and were intentionally NOT added to
    // processedCards. Re-run a full scan now so they get a real verdict
    // instead of staying permanently unmasked.
    console.debug("[murky] embedding model ready — re-scoring deferred cards");
    void processAllCards();
  });

  chrome.storage.onChanged.addListener(async (c) => {
    if (c.murkyProfile) {
      profile = (c.murkyProfile.newValue as UserProfile) ?? {};
      promptHash = shortHash((profile.prompt ?? "").trim());
    }
    if (c.murkyScorerId) {
      scorer = await getActiveScorer();
      scorerConfig = await getScorerConfig(scorer.id);
      console.debug("[murky] scorer switched to:", scorer.id);
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.murkyRevealed) {
      revealedCards = new Set(
        (changes.murkyRevealed.newValue as string[]) ?? []
      );
      updateAllMasks();
    }
  });

  startCollector(adapter.siteId);
  void initBehaviorCollector(adapter.siteId);

  // --- Card detection ---
  function getCardId(card: HTMLElement): string | null {
    const link =
      card.querySelector<HTMLAnchorElement>("a[href]") ??
      card.closest<HTMLAnchorElement>("a[href]");
    if (!link) return null;
    return adapter.extractProductId(link)?.raw ?? null;
  }

  function getProductId(card: HTMLElement): ProductId | null {
    const link =
      card.querySelector<HTMLAnchorElement>("a[href]") ??
      card.closest<HTMLAnchorElement>("a[href]");
    if (!link) return null;
    return adapter.extractProductId(link);
  }

  function findProductCards(): HTMLElement[] {
    const cards = new Set<HTMLElement>();

    for (const sel of adapter.cardSelectors) {
      document
        .querySelectorAll<HTMLElement>(sel)
        .forEach((el) => cards.add(el));
    }

    if (cards.size === 0 && adapter.fallbackFindCards) {
      adapter.fallbackFindCards(document).forEach((el) => cards.add(el));
    }

    return Array.from(cards);
  }

  // --- Mounting masks via the registry ---
  async function attachMaskToCard(card: HTMLElement, cardId: string | null): Promise<void> {
    if (processedCards.has(card)) return;

    const productId: ProductId | null = getProductId(card);
    const features = timings.measureSync("scrape", () =>
      adapter.scrapeFeatures(card)
    );

    // Shopee hydrates card text after the element enters the DOM. If we
    // run before hydration, features.title is null and we'd end up with
    // "Title not found" masks forever. Bail out without marking the card
    // processed so the next MutationObserver tick retries.
    if (!features.title) return;

    // Score the product — but check the decision cache first. A cache
    // hit short-circuits the (potentially 50+ ms) embedding call. The
    // cache key embeds productKey + scorer + promptHash, so a change to
    // any of those three naturally invalidates the entry by missing.
    let wasMasked = false;
    let deferredForModel = false;
    const productKey = productId
      ? `${adapter.siteId}:${productId.itemId}`
      : null;
    const cacheKey = productKey
      ? makeCacheKey(productKey, scorer.id, promptHash)
      : null;

    const cached = cacheKey ? decisionCache.get(cacheKey) : undefined;
    if (cached) {
      wasMasked = cached.shouldMask;
    } else {
      try {
        const decision = await timings.measure("score", () =>
          Promise.resolve(
            scorer.score({
              productId,
              features,
              profile,
              config: scorerConfig,
              pageUrl: window.location.href,
            })
          )
        );
        wasMasked = decision.shouldMask;
        // Cards scored during model warm-up should be retried once the
        // model is ready (see onModelReady above). Don't poison them by
        // marking processed; let the re-scan find them again.
        deferredForModel = decision.reason === "model-loading";
        // Only cache real decisions, not the warm-up no-op.
        if (cacheKey && !deferredForModel) {
          decisionCache.set(cacheKey, {
            shouldMask: wasMasked,
            scoredAt: Date.now(),
          });
        }
        if (productId) {
          console.debug(
            "[murky] score",
            productId.itemId,
            decision.modelId,
            decision.score.toFixed(2),
            decision.reason
          );
        }
      } catch (e) {
        console.warn("[murky] scorer threw, defaulting to no-mask", e);
      }
    }
    if (deferredForModel) return;
    processedCards.add(card);

    if (productId) {
      recordImpression(productId, features, wasMasked);
      recordBehaviorImpression(
        `${adapter.siteId}:${productId.itemId}`,
        wasMasked
      );
    }

    if (!wasMasked) {
      // Mask-first CSS hides every saved-site card by default; tag this
      // one as cleared so the visibility:hidden rule no longer applies.
      // No-op on sites without the mask-first stylesheet (the class is
      // just unused there).
      card.classList.add("murky-revealed");
      return;
    }

    const ctx: MaskContext = {
      productId,
      features,
      onReveal: () => {
        if (cardId) {
          revealedCards.add(cardId);
          chrome.storage.local.set({
            murkyRevealed: Array.from(revealedCards),
          });
        }
        if (productId) {
          recordUnmask(productId.itemId);
          recordBehaviorUnmask(`${adapter.siteId}:${productId.itemId}`);
        }
      },
      onRemask: () => {
        if (cardId) {
          revealedCards.delete(cardId);
          chrome.storage.local.set({
            murkyRevealed: Array.from(revealedCards),
          });
        }
        if (productId) {
          recordRemask(productId.itemId);
          recordBehaviorRemask(`${adapter.siteId}:${productId.itemId}`);
        }
      },
      onInteraction: (label, payload) => {
        if (productId) {
          console.debug(
            "[murky] interaction",
            label,
            productId.itemId,
            payload
          );
        }
      },
    };

    const mask = timings.measureSync("mount", () => {
      const factory = registry.pick(ctx);
      const m = factory.create(ctx);
      m.mount(card, ctx);
      maskedCards.add(card);
      // Counterpart to the mask-first CSS: the card is now covered by
      // mask art so we can safely make it visible (the user sees the
      // mask, not the underlying content).
      card.classList.add("murky-masked");
      const isAlreadyRevealed = cardId !== null && revealedCards.has(cardId);
      m.setVisible(!isAlreadyRevealed);
      return m;
    });

    cardMasks.set(card, mask);

    const productLink =
      card.querySelector<HTMLAnchorElement>("a[href]") ??
      card.closest<HTMLAnchorElement>("a[href]");
    if (productLink && productId) {
      productLink.addEventListener("click", () => {
        recordClick(productId.itemId);
        recordBehaviorClick(`${adapter.siteId}:${productId.itemId}`, wasMasked);
        // Cross-origin click trace: ask the background worker to
        // schedule a gentle "does this fit?" check on the destination
        // page. The high-value signal is clicks on cards the user had
        // to unmask (i.e., they bypassed our recommendation). For
        // never-masked cards the regret signal is weaker; we still
        // send it so the background can decide whether to prompt.
        const userBypassedMask =
          wasMasked && cardId !== null && revealedCards.has(cardId);
        chrome.runtime.sendMessage({
          type: "trace-click",
          href: productLink.href,
          siteId: adapter.siteId,
          productKey: `${adapter.siteId}:${productId.itemId}`,
          title: features.title ?? null,
          wasMasked,
          userBypassedMask,
          clickedAt: Date.now(),
        });
      });
    }
  }

  // --- Update existing masks (for global toggle / reset) ---
  function updateAllMasks(): void {
    for (const card of maskedCards) {
      if (!card.isConnected) {
        maskedCards.delete(card);
        continue;
      }
      const mask = cardMasks.get(card);
      if (!mask) continue;

      const cardId = getCardId(card);
      const isRevealed = cardId !== null && revealedCards.has(cardId);
      mask.setVisible(!isRevealed);
    }
  }

  async function processAllCards(): Promise<void> {
    const cards = findProductCards();
    if (cards.length === 0) return;
    const t0 = performance.now();
    // Cards are scored concurrently in JS, but the embedding scorer's
    // wasm inference is single-threaded → they effectively serialize.
    // Awaiting all settled lets us flush a coherent timing summary.
    await Promise.allSettled(
      cards.map((card) => attachMaskToCard(card, getCardId(card)))
    );
    if (timings.isEnabled()) {
      const wall = performance.now() - t0;
      console.log(
        `[murky timing] page scan: ${cards.length} cards, wall=${wall.toFixed(0)}ms`
      );
      timings.flush(`per-card breakdown (${cards.length} cards)`);
    }
  }

  // --- Initial scan ---
  void processAllCards();

  // --- MutationObserver for lazy-rendered cards ---
  let isProcessing = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const observer = new MutationObserver((mutations) => {
    if (isProcessing) return;

    let shouldProcess = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (
          node.nodeType === Node.ELEMENT_NODE &&
          !(node as HTMLElement).classList?.contains("murky-mask-overlay") &&
          !(node as HTMLElement).classList?.contains("murky-toggle-btn")
        ) {
          shouldProcess = true;
          break;
        }
      }
      if (shouldProcess) break;
    }

    if (shouldProcess) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        // processAllCards is now async; keep the re-entrancy guard
        // truthful by clearing it only after the scan resolves.
        isProcessing = true;
        void processAllCards().finally(() => {
          isProcessing = false;
        });
      }, 300);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}
