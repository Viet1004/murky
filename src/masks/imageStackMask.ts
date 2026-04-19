import { BaseMask } from "./baseMask";
import { MaskFactory, MaskContext, Mask } from "./types";

/**
 * N-layer image mask. The user clicks to peel layers one at a time
 * (top → bottom) until all layers are gone and the product is revealed.
 *
 * - 1 layer  = single image, one click to reveal (same as old ImageMask)
 * - 2 layers = same as old TwoLayerMask
 * - N layers = N clicks to reveal
 */
export class ImageStackMask extends BaseMask {
  private layers: HTMLImageElement[] = [];
  private tapCount = 0;

  constructor(private readonly imageUrls: string[]) {
    super();
  }

  protected buildContent(host: HTMLDivElement): void {
    // Build layers bottom-up: first URL = bottom, last URL = top (shown first).
    for (let i = 0; i < this.imageUrls.length; i++) {
      const img = document.createElement("img");
      img.className = "murky-mask-image";
      img.src = this.imageUrls[i];
      img.alt = "Masked";
      img.style.position = "absolute";
      img.style.inset = "0";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "contain";
      img.style.backgroundColor = "#ffffff";
      img.style.zIndex = String(i + 1);
      img.style.transition = "opacity 0.3s ease";
      host.appendChild(img);
      this.layers.push(img);
    }

    host.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.handleTap();
    });
  }

  private handleTap(): void {
    this.tapCount += 1;
    this.ctx?.onInteraction("stack-tap", {
      tapCount: this.tapCount,
      totalLayers: this.layers.length,
    });

    // Peel from top (last in array) to bottom (first in array).
    const layerIndex = this.layers.length - this.tapCount;
    if (layerIndex >= 0) {
      const layer = this.layers[layerIndex];
      layer.style.opacity = "0";
      setTimeout(() => {
        layer.style.pointerEvents = "none";
      }, 300);
    }

    if (this.tapCount >= this.layers.length) {
      // Small delay so the last layer fade is visible before reveal.
      setTimeout(() => this.reveal(), 320);
    }
  }
}

export class ImageStackMaskFactory implements MaskFactory {
  readonly kind = "image-stack";

  constructor(private readonly imageUrls: string[]) {}

  create(_ctx: MaskContext): Mask {
    return new ImageStackMask(this.imageUrls);
  }
}
