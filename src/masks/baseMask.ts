import { Mask, MaskContext } from "./types";

/**
 * Base class that handles the plumbing every mask needs:
 *  - positioning the host element on top of the card
 *  - tracking revealed state
 *  - global visibility toggle
 *
 * Concrete masks override `buildContent()` and call `reveal()` /
 * `remask()` from inside their own event handlers.
 */
export abstract class BaseMask implements Mask {
  protected host: HTMLDivElement | null = null;
  protected card: HTMLElement | null = null;
  protected ctx: MaskContext | null = null;
  protected revealed = false;
  protected globallyVisible = true;

  mount(card: HTMLElement, ctx: MaskContext): void {
    this.card = card;
    this.ctx = ctx;

    // Ensure card is positioned so we can absolute-position the host
    card.classList.add("murky-card-wrapper");
    const computed = window.getComputedStyle(card);
    if (computed.position === "static") {
      card.style.position = "relative";
    }

    // The host is a vertical flex container: a media area on top (where
    // the concrete mask paints its image/blur/etc.) and a fixed caption
    // at the bottom. Masks only see and draw into the media area, so
    // they don't need to know the caption exists.
    const host = document.createElement("div");
    host.className = "murky-mask-overlay";
    this.host = host;

    const media = document.createElement("div");
    media.className = "murky-media";
    host.appendChild(media);

    this.buildContent(media);

    // Universal caption below the media area.
    const rawTitle = ctx.features.title;
    const title = rawTitle
      ? rawTitle.length > 50
        ? rawTitle.slice(0, 50).trimEnd() + "…"
        : rawTitle
      : "Title not found";
    console.debug("[murky] caption for", ctx.productId?.itemId, "=>", title);

    const caption = document.createElement("div");
    caption.className = "murky-caption";
    caption.textContent = title;
    host.appendChild(caption);

    card.appendChild(host);
  }

  unmount(): void {
    if (this.host && this.host.parentElement) {
      this.host.parentElement.removeChild(this.host);
    }
    this.host = null;
    this.card = null;
    this.ctx = null;
  }

  setVisible(visible: boolean): void {
    this.globallyVisible = visible;
    this.applyVisibility();
  }

  isRevealed(): boolean {
    return this.revealed;
  }

  /** Concrete masks must implement this. */
  protected abstract buildContent(host: HTMLDivElement): void;

  /** Called by concrete masks when the user has fully solved the mask. */
  protected reveal(): void {
    if (this.revealed) return;
    this.revealed = true;
    this.applyVisibility();
    this.ctx?.onReveal();
  }

  /** Called by concrete masks when the user re-masks. */
  protected remask(): void {
    if (!this.revealed) return;
    this.revealed = false;
    this.applyVisibility();
    this.ctx?.onRemask();
  }

  private applyVisibility(): void {
    if (!this.host) return;
    const shouldHide = this.revealed || !this.globallyVisible;
    this.host.classList.toggle("murky-hidden", shouldHide);
  }
}
