import { BaseMask } from "./baseMask";
import { MaskFactory, MaskContext, Mask } from "./types";

/**
 * Two stacked images. The user must tap twice to reveal — adding
 * friction without being a real puzzle. The top layer fades out
 * on the first tap, then the bottom layer fades on the second.
 */
export class TwoLayerMask extends BaseMask {
  private layer1!: HTMLImageElement;
  private layer2!: HTMLImageElement;
  private tapCount = 0;

  constructor(
    private readonly topImageUrl: string,
    private readonly bottomImageUrl: string
  ) {
    super();
  }

  protected buildContent(host: HTMLDivElement): void {
    this.layer2 = this.makeLayer(this.bottomImageUrl, 1); // bottom (drawn first)
    this.layer1 = this.makeLayer(this.topImageUrl, 2);   // top (drawn over bottom)
    host.appendChild(this.layer2);
    host.appendChild(this.layer1);

    host.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.handleTap();
    });
  }

  private makeLayer(url: string, z: number): HTMLImageElement {
    const img = document.createElement("img");
    img.className = "murky-mask-image";
    img.src = url;
    img.alt = "Masked";
    img.style.position = "absolute";
    img.style.inset = "0";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.style.backgroundColor = "#ffffff";
    img.style.zIndex = String(z);
    img.style.transition = "opacity 0.3s ease";
    return img;
  }

  private handleTap(): void {
    this.tapCount += 1;
    this.ctx?.onInteraction("two-layer-tap", { tapCount: this.tapCount });

    if (this.tapCount === 1) {
      this.layer1.style.opacity = "0";
      // Once the first layer fades, drop it from event flow
      window.setTimeout(() => {
        if (this.layer1) this.layer1.style.pointerEvents = "none";
      }, 300);
    } else if (this.tapCount >= 2) {
      this.reveal();
    }
  }
}

export class TwoLayerMaskFactory implements MaskFactory {
  readonly kind = "two-layer";
  constructor(
    private readonly top: string,
    private readonly bottom: string
  ) {}
  create(_ctx: MaskContext): Mask {
    return new TwoLayerMask(this.top, this.bottom);
  }
}
