import { recordMaskReveal } from "../packs";
import { BaseMask } from "./baseMask";
import { activateBehavior, BehaviorHandle } from "./behaviors";
import type { Mask, MaskContext, MaskFactory } from "./types";

/**
 * Generic mask that mounts server-compiled HTML and activates a named behavior.
 *
 * This is the v009+ render path. The server returns:
 *   - `render_html`: the literal HTML to mount, with `data-murky-behavior="X"`
 *     on the outermost element
 *   - `behavior`: the id `X` so we can dispatch even if the HTML is empty
 *
 * The same HtmlMask handles every mask type the server can produce
 * (image-stack, flash-card, quote, …). Behavior modules in
 * `./behaviors/` own the actual interaction code.
 *
 * Sanitization expectations: the server is responsible for stripping
 * <script> / on* attributes / etc. The extension trusts the bytes it
 * receives from the murky-server. (For user-authored html-snippet masks
 * the server runs nh3 + URL allowlist before storing.)
 *
 * "Consume on reveal": HtmlMask carries `maskId` and `collectionId` so
 * when the behavior's reveal() fires we can also POST /me/masks/{id}/reveal,
 * which drops this mask from the user's copy of the collection (see
 * sql/011_mask_reveals.sql). Local fallback masks construct without IDs
 * — empty strings disable the API call.
 */
export class HtmlMask extends BaseMask {
  constructor(
    private readonly html: string,
    private readonly behavior: string,
    private readonly maskId: string,
    private readonly collectionId: string
  ) {
    super();
  }

  protected buildContent(host: HTMLDivElement): void {
    // Drop the compiled HTML straight into the media area. The element's
    // outer wrapper carries `data-murky-behavior`; the activator finds it
    // and attaches handlers.
    host.innerHTML = this.html;

    // Look for the behavior-carrying element. Compiler convention puts the
    // attribute on a single root element, but we don't depend on that —
    // querySelector picks the first match.
    const root = host.querySelector<HTMLElement>("[data-murky-behavior]")
      ?? host;  // fall back to host itself if compiler omitted the attribute

    const handle: BehaviorHandle = {
      reveal: () => {
        // Fire-and-forget the server-side consume call. Done before the
        // local reveal so even if reveal() triggers DOM teardown that
        // unmounts us, the network promise was already kicked off.
        if (this.maskId && this.collectionId) {
          void recordMaskReveal(this.maskId, this.collectionId);
        }
        this.reveal();
      },
      recordInteraction: (label, payload) =>
        this.ctx?.onInteraction(label, payload),
    };

    activateBehavior(this.behavior, root, handle);
  }
}

export class HtmlMaskFactory implements MaskFactory {
  /** Telemetry tag — uses the behavior id since that's the interesting axis
   * across all server-compiled masks. */
  readonly kind: string;

  constructor(
    private readonly html: string,
    private readonly behavior: string,
    private readonly maskId: string = "",
    private readonly collectionId: string = ""
  ) {
    this.kind = `html:${behavior}`;
  }

  create(_ctx: MaskContext): Mask {
    return new HtmlMask(this.html, this.behavior, this.maskId, this.collectionId);
  }
}
