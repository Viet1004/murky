/**
 * Gentle regret prompt — injected by the background worker into a tab
 * that the user navigated to after clicking a tracked card. Background
 * passes the trace context via window globals on injection.
 *
 * Behavior:
 *   - Wait DWELL_MS before showing. If user navigates away first, no prompt.
 *   - Show a small bottom-right card with three buttons.
 *   - Always dismissible. Auto-dismiss after AUTO_DISMISS_MS of inaction.
 *   - Sends the response (or "skipped") to the background, which forwards
 *     it to the murky-server behavior endpoint as a "regret_check" event.
 */

import { recordRegretResponse, RegretContext, RegretResponse } from "./client";

const ROOT_ID = "murky-regret-root";
const DWELL_MS = 12_000;
const AUTO_DISMISS_MS = 30_000;

interface InjectionPayload {
  context: RegretContext;
  promptText: string;
}

declare global {
  interface Window {
    __MURKY_REGRET_PAYLOAD__?: InjectionPayload;
  }
}

const payload = window.__MURKY_REGRET_PAYLOAD__;
if (payload && !document.getElementById(ROOT_ID)) {
  // Wait for dwell — if the user immediately bounces, never ask.
  const dwellTimer = window.setTimeout(() => {
    if (document.visibilityState !== "visible") {
      // They tabbed away during dwell; skip silently.
      return;
    }
    showPrompt(payload);
  }, DWELL_MS);

  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") {
        window.clearTimeout(dwellTimer);
      }
    },
    { once: true }
  );
}

function showPrompt(payload: InjectionPayload): void {
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.style.cssText = `
    position: fixed;
    right: 20px; bottom: 20px;
    z-index: 2147483646;
    width: 300px;
    background: #faf7f2;
    color: #222;
    border: 1px solid #f5efe6;
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.15);
    padding: 14px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    user-select: none;
  `;
  root.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:8px;">
      <div style="font-weight:600; color:#f1641e;">Quick check 🎭</div>
      <button id="murky-regret-close" aria-label="Dismiss" style="background:none; border:none; cursor:pointer; color:#5e5e5e; font-size:16px; line-height:1; padding:0;">×</button>
    </div>
    <div id="murky-regret-text" style="margin-bottom:12px; color:#222;"></div>
    <div style="display:flex; gap:6px;">
      <button data-response="fits" style="flex:1; padding:7px 8px; border:1px solid #f5efe6; background:#fff; color:#222; border-radius:999px; cursor:pointer; font-size:12px; font-weight:500;">Yes, fits</button>
      <button data-response="not_sure" style="flex:1; padding:7px 8px; border:1px solid #f5efe6; background:#fff; color:#222; border-radius:999px; cursor:pointer; font-size:12px;">Not sure</button>
      <button data-response="regret" style="flex:1; padding:7px 8px; border:1px solid #f1641e; background:#fff; color:#f1641e; border-radius:999px; cursor:pointer; font-size:12px;">Not really</button>
    </div>
    <div style="margin-top:8px; font-size:10px; color:#5e5e5e;">Helps Murky learn what to mask. Murky never sees the page content — just your answer.</div>
  `;
  document.documentElement.appendChild(root);

  const textEl = root.querySelector<HTMLElement>("#murky-regret-text")!;
  textEl.textContent = payload.promptText;

  const dismissTimer = window.setTimeout(() => respond("skipped"), AUTO_DISMISS_MS);

  function respond(response: RegretResponse): void {
    window.clearTimeout(dismissTimer);
    void recordRegretResponse(payload.context, response).catch(() => undefined);
    root.remove();
  }

  root.querySelector("#murky-regret-close")?.addEventListener("click", () => respond("skipped"));
  for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-response]"))) {
    btn.addEventListener("click", () => respond(btn.dataset.response as RegretResponse));
  }
}
