import { getServerUrl, recordMaskReveal } from "../packs";
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

  private mediaHost: HTMLDivElement | null = null;

  protected buildContent(host: HTMLDivElement): void {
    // Remember the media area so we can restore the cover if a paid unmask is
    // blocked (402) and we need to re-mask + show the purchase prompt.
    this.mediaHost = host;

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
      // Server-authorized reveal: for a paid collection the server spends an
      // unmask-credit and returns 402 when the buyer is out. On 402 we keep the
      // mask covered and prompt a purchase; otherwise (success, free/owner, or a
      // soft network error) we complete the reveal so a blip never blocks it.
      reveal: async () => {
        if (this.maskId && this.collectionId) {
          const res = await recordMaskReveal(this.maskId, this.collectionId);
          if (res.paymentRequired) {
            this.showLocked();
            return;
          }
        }
        this.reveal();
      },
      recordInteraction: (label, payload) =>
        this.ctx?.onInteraction(label, payload),
    };

    activateBehavior(this.behavior, root, handle);
  }

  /** Out of unmask-credits: restore the cover and overlay a buy prompt. */
  private showLocked(): void {
    if (!this.mediaHost) {
      return; // nothing to restore; leave the mask as-is rather than reveal free
    }
    // Re-mount the compiled HTML to restore the cover (undo the peel/flip).
    this.buildContent(this.mediaHost);
    this.mediaHost.style.position = this.mediaHost.style.position || "relative";

    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "absolute",
      inset: "0",
      zIndex: "50",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "10px",
      padding: "12px",
      textAlign: "center",
      background: "rgba(0,0,0,0.62)",
      color: "#ffffff",
      backdropFilter: "blur(2px)",
    });

    const msg = document.createElement("div");
    msg.textContent = "Out of unlocks for this collection";
    Object.assign(msg.style, { fontSize: "13px", fontWeight: "600", lineHeight: "1.3" });

    const btn = document.createElement("button");
    btn.textContent = "Get more";
    Object.assign(btn.style, {
      cursor: "pointer",
      border: "none",
      borderRadius: "9999px",
      padding: "6px 16px",
      fontSize: "13px",
      fontWeight: "600",
      color: "#ffffff",
      background: "#f1641e",
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.openStore();
    });

    overlay.appendChild(msg);
    overlay.appendChild(btn);
    this.mediaHost.appendChild(overlay);
  }

  private async openStore(): Promise<void> {
    try {
      const base = await getServerUrl();
      window.open(`${base}/browse`, "_blank", "noopener");
    } catch {
      // best-effort — nothing else to do if we can't resolve the server URL
    }
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
