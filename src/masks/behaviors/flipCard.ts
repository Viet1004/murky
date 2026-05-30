import type { BehaviorActivator } from "./index";

/**
 * flip-card: 1st input flips the card, 2nd input reveals.
 *
 * Layout contract (from the server-side flash-card compiler):
 *   <div data-murky-behavior="flip-card" data-flip-on="click|hover">
 *     <div class="murky-flash-card-face murky-flash-card-front">…</div>
 *     <div class="murky-flash-card-face murky-flash-card-back">…</div>
 *   </div>
 *
 * `data-flip-on` selects the trigger. "click" is the impulse-buying-block
 * default — two deliberate gestures before reveal. "hover" is more whimsical
 * (the card flips on mouseover; click reveals).
 *
 * Styling lives entirely here, not in the server output, so changing the
 * flip animation (e.g. horizontal vs vertical) is one file. The compiler
 * stays stable.
 */
export const flipCardBehavior: BehaviorActivator = (root, handle) => {
  const flipOn = (root.getAttribute("data-flip-on") || "click") as "click" | "hover";
  const frontEl = root.querySelector<HTMLElement>(".murky-flash-card-front");
  const backEl = root.querySelector<HTMLElement>(".murky-flash-card-back");
  if (!frontEl || !backEl) return;
  // Capture as non-null locals so the closure below isn't fighting the
  // null narrowing across function boundaries.
  const front: HTMLElement = frontEl;
  const back: HTMLElement = backEl;

  // Layer the two faces. Front starts visible; back hidden behind it.
  // Using opacity (not CSS 3D transforms) keeps the implementation
  // robust — no perspective container needed, works inside arbitrary
  // card layouts on every site.
  const baseStyle = {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    transition: "opacity 0.35s ease",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
    overflow: "hidden",
  } as Partial<CSSStyleDeclaration>;

  Object.assign(front.style, baseStyle, { zIndex: "2", opacity: "1" });
  Object.assign(back.style, baseStyle, { zIndex: "1", opacity: "0" });

  // Ensure inline images and text fill the face nicely.
  for (const img of root.querySelectorAll<HTMLImageElement>("img")) {
    Object.assign(img.style, { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" });
  }
  for (const txt of root.querySelectorAll<HTMLElement>(".murky-text")) {
    Object.assign(txt.style, {
      padding: "12px",
      fontSize: "14px",
      lineHeight: "1.4",
      textAlign: "center",
      color: "#222",
    } as Partial<CSSStyleDeclaration>);
  }

  let stage: "front" | "back" = "front";

  function flip() {
    if (stage === "front") {
      stage = "back";
      front.style.opacity = "0";
      back.style.opacity = "1";
      handle.recordInteraction("flip", { to: "back" });
    } else {
      // 2nd input on a flipped card reveals.
      handle.recordInteraction("reveal-from-back", {});
      // Slight delay so the user sees the back briefly before the unmask.
      window.setTimeout(() => handle.reveal(), 120);
    }
  }

  // Always make `click` reveal-when-flipped, even in hover mode — otherwise
  // touch-only users (no hover) couldn't reveal.
  root.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    flip();
  });

  if (flipOn === "hover") {
    // Hover only flips the FIRST time. Subsequent reveal still goes through click.
    let hoverConsumed = false;
    root.addEventListener("mouseenter", () => {
      if (hoverConsumed || stage !== "front") return;
      hoverConsumed = true;
      flip();
    });
  }
};
