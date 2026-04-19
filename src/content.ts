import { ProductId, MaskLevel } from "./types";
import { pickAdapter, SiteAdapter } from "./adapters";
import {
  startCollector,
  recordImpression,
  recordUnmask,
  recordRemask,
  recordClick,
} from "./collector";
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

// --- Pick the adapter for the current site ---
const adapter: SiteAdapter | null = pickAdapter(window.location.hostname);

if (!adapter) {
  console.debug("[murky] no adapter for", window.location.hostname);
} else {
  // Gate on the global enable flag before doing anything. If the user has
  // disabled the extension, bail out entirely so the page renders untouched.
  // The popup toggles this flag and then reloads the tab, so we don't need
  // to react to changes at runtime.
  chrome.storage.local.get(["murkyEnabled"], (result: { [key: string]: unknown }) => {
    if (result.murkyEnabled === false) {
      console.debug("[murky] disabled, skipping");
      return;
    }
    // Load the active pack from the server before starting. We block the
    // first scan on this so we don't briefly show local-only masks before
    // the remote ones arrive.
    loadActiveCollection()
      .then((col) => run(adapter, col))
      .catch((e) => {
        console.warn("[murky] loadActiveCollection failed, using local fallback", e);
        run(adapter, null);
      });
  });
}

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

function run(adapter: SiteAdapter, collection: CollectionDetail | null): void {
  const registry = buildRegistry(collection);

  // --- State ---
  let maskLevel: MaskLevel = "full";
  let revealedCards = new Set<string>();
  const processedCards = new WeakSet<HTMLElement>();
  // Regular Set holds strong refs; prune detached nodes on each remount.
  const maskedCards: Set<HTMLElement> = new Set();
  const cardMasks = new WeakMap<HTMLElement, Mask>();

  // --- Storage init ---
  chrome.storage.local.get(
    ["murkyRevealed", "murkyMaskLevel"],
    (result: { [key: string]: unknown }) => {
      maskLevel = (result.murkyMaskLevel as MaskLevel | undefined) ?? "full";
      revealedCards = new Set(
        (result.murkyRevealed as string[] | undefined) ?? []
      );
      processAllCards();
    }
  );

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.murkyRevealed) {
      revealedCards = new Set(
        (changes.murkyRevealed.newValue as string[]) ?? []
      );
      updateAllMasks();
    }
    if (changes.murkyMaskLevel) {
      maskLevel = (changes.murkyMaskLevel.newValue as MaskLevel) ?? "full";
      remountAllCards();
    }
  });

  startCollector(adapter.siteId);

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

  // --- Mask target selection ---
  function pickMaskTarget(card: HTMLElement): HTMLElement | null {
    switch (maskLevel) {
      case "image":
        return adapter.findImageElement(card) ?? card;
      case "discount":
        return adapter.findDiscountElement(card);
      case "full":
      default:
        return card;
    }
  }

  // --- Mounting masks via the registry ---
  function attachMaskToCard(card: HTMLElement, cardId: string | null): void {
    if (processedCards.has(card)) return;

    const productId: ProductId | null = getProductId(card);
    const features = adapter.scrapeFeatures(card);

    // Shopee hydrates card text after the element enters the DOM. If we
    // run before hydration, features.title is null and we'd end up with
    // "Title not found" masks forever. Bail out without marking the card
    // processed so the next MutationObserver tick retries.
    if (!features.title) return;

    processedCards.add(card);
    const wasMasked = Math.random() > 0.5;

    if (productId) {
      recordImpression(productId, features, wasMasked);
    }

    if (!wasMasked) return;

    const target = pickMaskTarget(card);
    if (!target) return;

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
        if (productId) recordUnmask(productId.itemId);
      },
      onRemask: () => {
        if (cardId) {
          revealedCards.delete(cardId);
          chrome.storage.local.set({
            murkyRevealed: Array.from(revealedCards),
          });
        }
        if (productId) recordRemask(productId.itemId);
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

    const factory = registry.pick(ctx);
    const mask = factory.create(ctx);
    mask.mount(target, ctx);
    maskedCards.add(card);

    const isAlreadyRevealed = cardId !== null && revealedCards.has(cardId);
    mask.setVisible(!isAlreadyRevealed);

    cardMasks.set(card, mask);

    const productLink =
      card.querySelector<HTMLAnchorElement>("a[href]") ??
      card.closest<HTMLAnchorElement>("a[href]");
    if (productLink && productId) {
      productLink.addEventListener("click", () => {
        recordClick(productId.itemId);
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

  function processAllCards(): void {
    const cards = findProductCards();
    for (const card of cards) {
      const cardId = getCardId(card);
      attachMaskToCard(card, cardId);
    }
  }

  /**
   * Tear down all existing masks and re-attach them using the current
   * maskLevel. Called when the user changes the level in the popup.
   */
  function remountAllCards(): void {
    const toRemount: HTMLElement[] = [];

    for (const card of maskedCards) {
      if (!card.isConnected) {
        maskedCards.delete(card);
        continue;
      }
      const mask = cardMasks.get(card);
      if (mask) {
        mask.unmount();
        cardMasks.delete(card);
      }
      toRemount.push(card);
    }
    maskedCards.clear();

    for (const card of toRemount) {
      forceAttachMask(card);
    }
  }

  /**
   * Re-attach a mask to a card that was previously masked. Bypasses
   * the random coin flip because we know this card should be masked.
   */
  function forceAttachMask(card: HTMLElement): void {
    const cardId = getCardId(card);
    const productId: ProductId | null = getProductId(card);
    const features = adapter.scrapeFeatures(card);

    const target = pickMaskTarget(card);
    if (!target) return;

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
        if (productId) recordUnmask(productId.itemId);
      },
      onRemask: () => {
        if (cardId) {
          revealedCards.delete(cardId);
          chrome.storage.local.set({
            murkyRevealed: Array.from(revealedCards),
          });
        }
        if (productId) recordRemask(productId.itemId);
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

    const factory = registry.pick(ctx);
    const mask = factory.create(ctx);
    mask.mount(target, ctx);

    const isRevealed = cardId !== null && revealedCards.has(cardId);
    mask.setVisible(!isRevealed);

    cardMasks.set(card, mask);
    maskedCards.add(card);
  }

  // --- Initial scan ---
  processAllCards();

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
        isProcessing = true;
        processAllCards();
        isProcessing = false;
      }, 300);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}
