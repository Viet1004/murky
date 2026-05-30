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
 */
export class HtmlMask extends BaseMask {
  constructor(
    private readonly html: string,
    private readonly behavior: string
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
      reveal: () => this.reveal(),
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
    private readonly behavior: string
  ) {
    this.kind = `html:${behavior}`;
  }

  create(_ctx: MaskContext): Mask {
    return new HtmlMask(this.html, this.behavior);
  }
}
