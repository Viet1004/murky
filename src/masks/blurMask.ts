import { BaseMask } from "./baseMask";
import { MaskFactory, MaskContext, Mask } from "./types";

/**
 * Pure-CSS blur over a colored backdrop with a "Hold to reveal" prompt.
 * The user must press and hold for 800ms to reveal — friction by patience.
 */
export class BlurMask extends BaseMask {
  private holdTimer: number | null = null;

  protected buildContent(host: HTMLDivElement): void {
    host.style.backdropFilter = "blur(20px)";
    host.style.background = "rgba(20, 20, 30, 0.7)";

    const label = document.createElement("div");
    label.textContent = "Hold to reveal";
    label.style.color = "#fff";
    label.style.fontSize = "13px";
    label.style.fontWeight = "600";
    label.style.fontFamily = "system-ui, sans-serif";
    label.style.padding = "8px 14px";
    label.style.background = "rgba(0,0,0,0.5)";
    label.style.borderRadius = "20px";
    label.style.userSelect = "none";
    host.appendChild(label);

    const start = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.ctx?.onInteraction("blur-hold-start");
      this.holdTimer = window.setTimeout(() => {
        this.ctx?.onInteraction("blur-hold-complete");
        this.reveal();
      }, 800);
    };
    const cancel = () => {
      if (this.holdTimer !== null) {
        window.clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }
    };

    host.addEventListener("mousedown", start);
    host.addEventListener("touchstart", start, { passive: false });
    host.addEventListener("mouseup", cancel);
    host.addEventListener("mouseleave", cancel);
    host.addEventListener("touchend", cancel);
    host.addEventListener("touchcancel", cancel);
  }
}

export class BlurMaskFactory implements MaskFactory {
  readonly kind = "blur-hold";
  create(_ctx: MaskContext): Mask {
    return new BlurMask();
  }
}
