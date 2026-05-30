import type { BehaviorActivator } from "./index";

/**
 * peel-stack: a stack of <img data-layer="N"> elements that fade out one at a
 * time on click (top → bottom) until the underlying card is revealed.
 *
 * Layout contract (from the server-side image-stack compiler):
 *   <div data-murky-behavior="peel-stack">
 *     <img src="…" data-layer="0">   ← bottom-most layer
 *     <img src="…" data-layer="1">
 *     <img src="…" data-layer="N-1"> ← top-most layer (clicked first)
 *   </div>
 *
 * The styling lives here, not in the server-emitted HTML, so we keep the wire
 * format CSS-free (option A from the security review). If the visual treatment
 * changes (e.g. rotate instead of fade), edit this file; the server emits the
 * same HTML.
 */
export const peelStackBehavior: BehaviorActivator = (root, handle) => {
  const layers = Array.from(
    root.querySelectorAll<HTMLImageElement>("img[data-layer]")
  ).sort(
    (a, b) =>
      Number(a.dataset.layer ?? "0") - Number(b.dataset.layer ?? "0")
  );

  // Style the layers — absolute-positioned, stacked by data-layer index.
  // Higher data-layer == on top (rendered last in source order anyway, but
  // explicit z-index makes the ordering robust to reflow / mutation).
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: "contain",
      backgroundColor: "#ffffff",
      zIndex: String(i + 1),
      transition: "opacity 0.3s ease",
    });
  }

  let tapCount = 0;

  root.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    tapCount += 1;
    handle.recordInteraction("stack-tap", {
      tapCount,
      totalLayers: layers.length,
    });

    // Peel from the top (highest data-layer / last in sorted array).
    const layerIndex = layers.length - tapCount;
    if (layerIndex >= 0) {
      const layer = layers[layerIndex];
      layer.style.opacity = "0";
      window.setTimeout(() => {
        layer.style.pointerEvents = "none";
      }, 300);
    }

    if (tapCount >= layers.length) {
      // Let the last fade finish before pulling the overlay down.
      window.setTimeout(() => handle.reveal(), 320);
    }
  });
};
