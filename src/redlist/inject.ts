/**
 * Red-list block overlay — viewport-sized image-stack mask.
 *
 * Mirrors the per-element mask UX (src/masks/imageStackMask.ts): N
 * layers stacked top-down, one click peels the top layer, after the
 * last peel the "endgame" controls fade in (take-me-back + bypass).
 *
 * The mask layers come from the active server collection (or bundled
 * fallback), composed by background.ts in pickRedListMaskLayers().
 * This keeps the masking story coherent: same art at element scope or
 * page scope.
 *
 * Reads payload from window.__MURKY_REDLIST_PAYLOAD__ (set by a
 * separate tiny script call before this bundle loads) — same two-phase
 * pattern as the regret prompt.
 */

interface BlockPayload {
  hostnamePattern: string;
  label?: string;
  endsAt: string;
  bypassMinutes: number;
  /** Top-down image URLs. Last URL is visible first, peeled first. */
  maskLayers: string[];
}

const ROOT_ID = "murky-redlist-root";

if (!document.getElementById(ROOT_ID)) {
  mount();
}

function mount(): void {
  const payload = (window as unknown as {
    __MURKY_REDLIST_PAYLOAD__?: BlockPayload;
  }).__MURKY_REDLIST_PAYLOAD__;
  if (!payload) {
    console.warn("[murky redlist] mount called with no payload");
    return;
  }

  // Lock the underlying page so background scrolling / videos don't
  // sneak through behind the mask.
  document.documentElement.style.overflow = "hidden";

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.style.cssText = `
    position: fixed; inset: 0;
    z-index: 2147483647;
    background: #222;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    cursor: pointer;
  `;

  // --- Image stack: layered mask art covering the viewport -------------

  const layers: HTMLImageElement[] = [];
  const urls = payload.maskLayers.length > 0 ? payload.maskLayers : [""];
  // Stack bottom-up: first URL = bottom, last URL = top (peeled first).
  for (let i = 0; i < urls.length; i++) {
    const img = document.createElement("img");
    img.src = urls[i];
    img.alt = "";
    img.style.cssText = `
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      object-fit: contain;
      background-color: #ffffff;
      z-index: ${i + 1};
      transition: opacity 0.3s ease;
      user-select: none;
      pointer-events: none;
    `;
    root.appendChild(img);
    layers.push(img);
  }

  // --- Endgame card: shown after the last layer is peeled --------------

  const endgame = document.createElement("div");
  endgame.style.cssText = `
    position: absolute; inset: 0;
    z-index: ${urls.length + 10};
    display: flex; align-items: center; justify-content: center;
    background: rgba(34, 28, 20, 0.94);
    opacity: 0; pointer-events: none;
    transition: opacity 0.35s ease;
  `;
  const card = document.createElement("div");
  card.style.cssText = `
    background: #faf7f2;
    color: #222;
    border-radius: 16px;
    padding: 28px;
    max-width: 380px;
    width: 90%;
    box-shadow: 0 12px 48px rgba(0,0,0,0.35);
    text-align: center;
  `;
  const label = (payload.label || payload.hostnamePattern).trim();
  card.innerHTML = `
    <div style="font-size:34px; margin-bottom:8px;">🎭</div>
    <div style="font-size:18px; font-weight:600; color:#f1641e; margin-bottom:4px;">
      ${escapeHtml(label)} is paused
    </div>
    <div style="font-size:13px; color:#5e5e5e; margin-bottom:20px; line-height:1.5;">
      You asked Murky to block this site right now.<br/>
      Available again at <strong>${escapeHtml(payload.endsAt)}</strong>.
    </div>
    <button id="murky-redlist-back" style="
      width:100%; padding:10px; margin-bottom:8px;
      border:none; border-radius:999px;
      background:#f1641e; color:#fff; font-size:13px; font-weight:500;
      cursor:pointer;
    ">Take me back</button>
    <button id="murky-redlist-bypass" style="
      width:100%; padding:8px;
      border:1px solid #f5efe6; border-radius:999px;
      background:#fff; color:#5e5e5e; font-size:12px;
      cursor:pointer;
    ">Continue anyway for ${payload.bypassMinutes} minutes</button>
  `;
  endgame.appendChild(card);
  root.appendChild(endgame);

  // --- Peel-on-click logic — same convention as ImageStackMask ---------

  let tapCount = 0;
  function handleTap(): void {
    // Once the endgame is visible the root no longer accepts taps; this
    // guard is defensive (e.g., if a tap fires mid-transition).
    if (tapCount >= layers.length) return;
    tapCount += 1;
    const idx = layers.length - tapCount;
    if (idx >= 0) {
      const layer = layers[idx];
      layer.style.opacity = "0";
    }
    if (tapCount >= layers.length) {
      // Small delay so the last layer fade is visible before the
      // endgame card slides in.
      setTimeout(() => {
        endgame.style.opacity = "1";
        endgame.style.pointerEvents = "auto";
        root.style.cursor = "default";
      }, 320);
    }
  }
  root.addEventListener("click", (e) => {
    // Don't peel if the user clicked a button inside the endgame card.
    if ((e.target as HTMLElement | null)?.closest("button")) return;
    e.preventDefault();
    e.stopPropagation();
    handleTap();
  });

  document.documentElement.appendChild(root);

  // --- Endgame button wiring -------------------------------------------

  card
    .querySelector<HTMLButtonElement>("#murky-redlist-back")!
    .addEventListener("click", () => {
      if (history.length > 1) history.back();
      else window.close();
    });

  card
    .querySelector<HTMLButtonElement>("#murky-redlist-bypass")!
    .addEventListener("click", () => {
      chrome.runtime.sendMessage(
        {
          type: "redlist-bypass",
          hostnamePattern: payload.hostnamePattern,
          minutes: payload.bypassMinutes,
        },
        () => {
          // Reload so the page loads normally now that the bypass is
          // recorded — background's next webNavigation check sees it
          // and skips the block.
          location.reload();
        }
      );
    });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
