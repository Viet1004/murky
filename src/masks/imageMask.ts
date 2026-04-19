import { BaseMask } from "./baseMask";
import { MaskFactory, MaskContext, Mask } from "./types";

/**
 * The simplest mask: a single static image. One tap reveals.
 */
export class ImageMask extends BaseMask {
  constructor(private readonly imageUrl: string) {
    super();
  }

  protected buildContent(host: HTMLDivElement): void {
    const img = document.createElement("img");
    img.className = "murky-mask-image";
    img.src = this.imageUrl;
    img.alt = "Masked";
    host.appendChild(img);

    host.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.ctx?.onInteraction("image-tap");
      this.reveal();
    });
  }
}

export class ImageMaskFactory implements MaskFactory {
  readonly kind = "image";
  constructor(private readonly imageUrl: string) {}
  create(_ctx: MaskContext): Mask {
    return new ImageMask(this.imageUrl);
  }
}
