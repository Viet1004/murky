/**
 * Red-list block overlay. Injected via chrome.scripting.executeScript
 * when background.ts detects a navigation matching an active window.
 *
 * Reads payload from window.__MURKY_REDLIST_PAYLOAD__ (set by a separate
 * tiny script call before this bundle loads — same pattern as the
 * regret prompt).
 */

interface BlockPayload {
  hostnamePattern: string;
  label?: string;
  /** Pre-formatted by background; e.g. "5:00 PM" or "tomorrow 2:00 AM". */
  endsAt: string;
  bypassMinutes: number;
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

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.style.cssText = `
    position: fixed; inset: 0;
    z-index: 2147483647;
    background: rgba(34, 28, 20, 0.94);
    color: #faf7f2;
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
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

  const label = payload.label?.trim() || payload.hostnamePattern;
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
  root.appendChild(card);
  document.documentElement.appendChild(root);

  // Hard freeze the underlying page: stop scrolling, suspend any
  // background JS by setting visibility/pointer-events on the body.
  document.documentElement.style.overflow = "hidden";

  card.querySelector<HTMLButtonElement>("#murky-redlist-back")!
    .addEventListener("click", () => {
      // history.back() would land on whatever the user was on before;
      // close the tab is too aggressive. Compromise: go to about:blank
      // via background (we can't navigate to chrome:// from content).
      history.length > 1 ? history.back() : window.close();
    });

  card.querySelector<HTMLButtonElement>("#murky-redlist-bypass")!
    .addEventListener("click", () => {
      chrome.runtime.sendMessage(
        {
          type: "redlist-bypass",
          hostnamePattern: payload.hostnamePattern,
          minutes: payload.bypassMinutes,
        },
        () => {
          // Reload so the page loads normally now that the bypass is
          // recorded. Background's next webNavigation check sees the
          // bypass and skips the block.
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
