/**
 * Picker overlay — injected into the active tab when the user clicks
 * "Pick element" in the popup. Captures one click, generalizes a
 * repeating selector, asks the user to confirm, then saves to per-origin
 * storage and reloads the tab so the new selector takes effect.
 *
 * Lifecycle:
 *   1. Render full-page transparent SVG overlay that intercepts mouse.
 *   2. On mousemove, highlight the hovered element with an outlined rect
 *      cut out of the overlay's "ocean" fill.
 *   3. Up/Down arrow walks the parent ladder so user can climb to the
 *      right level. Esc cancels. Click confirms current selection.
 *   4. Show a small confirmation dialog with the recommended selector,
 *      a match-count preview, and Save/Cancel.
 *   5. On Save: write SiteSelectorConfig and `chrome.tabs.reload`.
 */

import { buildLadder, SelectorLadder } from "./selector";
import { saveConfig, originOf, getConfig } from "./store";

const ROOT_ID = "murky-picker-root";

interface PickerState {
  ladder: SelectorLadder | null;
  rungIndex: number;
  hoverEl: HTMLElement | null;
  frozen: boolean;
}

const state: PickerState = {
  ladder: null,
  rungIndex: 0,
  hoverEl: null,
  frozen: false,
};

// Bail out if already injected.
if (!document.getElementById(ROOT_ID)) {
  start();
}

function start(): void {
  const root = buildOverlay();
  document.documentElement.appendChild(root);
  attachListeners(root);
  console.debug("[murky picker] active");
}

function buildOverlay(): HTMLElement {
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.style.cssText = `
    position: fixed; inset: 0;
    z-index: 2147483647;
    pointer-events: auto;
    cursor: crosshair;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  // Highlight rect — outlines the hovered element. Position updated on
  // mousemove. The huge box-shadow doubles as the dim "ocean" outside
  // the island, so we don't need a separate full-viewport overlay.
  const island = document.createElement("div");
  island.id = "murky-picker-island";
  island.style.cssText = `
    position: absolute;
    border: 2px solid #f1641e;
    background: rgba(241, 100, 30, 0.12);
    box-shadow: 0 0 0 9999px rgba(34, 34, 34, 0.18);
    pointer-events: none;
    transition: opacity 0.05s linear;
    opacity: 0;
  `;
  // Hide ocean once an island is shown, so the cutout effect works via box-shadow.
  root.appendChild(island);

  // Banner (top, instructional).
  const banner = document.createElement("div");
  banner.id = "murky-picker-banner";
  banner.style.cssText = `
    position: absolute;
    top: 16px; left: 50%;
    transform: translateX(-50%);
    background: #fff;
    color: #222;
    padding: 8px 14px;
    border-radius: 999px;
    font-size: 13px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.15);
    border: 1px solid #f5efe6;
    pointer-events: none;
    user-select: none;
  `;
  banner.textContent = "Click an element to mask. Esc to cancel.";
  root.appendChild(banner);

  // Confirmation dialog (hidden until click).
  const dialog = document.createElement("div");
  dialog.id = "murky-picker-dialog";
  dialog.style.cssText = `
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    background: #faf7f2;
    color: #222;
    padding: 16px;
    border-radius: 12px;
    width: 320px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.25);
    border: 1px solid #f5efe6;
    display: none;
    user-select: none;
  `;
  dialog.innerHTML = `
    <div style="font-size:14px; font-weight:600; margin-bottom:8px; color:#f1641e;">
      Mask this element?
    </div>
    <div id="murky-picker-summary" style="font-size:12px; color:#5e5e5e; margin-bottom:10px; line-height:1.5;"></div>
    <div style="display:flex; gap:6px; margin-bottom:10px;">
      <button id="murky-picker-up" style="flex:1; padding:6px; border:1px solid #f5efe6; background:#fff; border-radius:6px; cursor:pointer; font-size:12px;">⬆ Wider</button>
      <button id="murky-picker-down" style="flex:1; padding:6px; border:1px solid #f5efe6; background:#fff; border-radius:6px; cursor:pointer; font-size:12px;">⬇ Narrower</button>
    </div>
    <input id="murky-picker-label" type="text" placeholder="Label (e.g. Product cards)" style="width:100%; padding:6px 8px; border:1px solid #f5efe6; border-radius:6px; font-size:12px; margin-bottom:10px; box-sizing:border-box;" />
    <div style="display:flex; gap:6px;">
      <button id="murky-picker-cancel" style="flex:1; padding:8px; border:1px solid #f5efe6; background:#fff; border-radius:999px; cursor:pointer; font-size:13px;">Cancel</button>
      <button id="murky-picker-save" style="flex:1; padding:8px; border:1px solid #f1641e; background:#f1641e; color:#fff; border-radius:999px; cursor:pointer; font-size:13px; font-weight:500;">Save & mask</button>
    </div>
  `;
  root.appendChild(dialog);

  return root;
}

function attachListeners(root: HTMLElement): void {
  const island = root.querySelector<HTMLElement>("#murky-picker-island")!;
  const dialog = root.querySelector<HTMLElement>("#murky-picker-dialog")!;
  const summary = root.querySelector<HTMLElement>("#murky-picker-summary")!;
  const labelInput = root.querySelector<HTMLInputElement>("#murky-picker-label")!;
  const upBtn = root.querySelector<HTMLButtonElement>("#murky-picker-up")!;
  const downBtn = root.querySelector<HTMLButtonElement>("#murky-picker-down")!;
  const saveBtn = root.querySelector<HTMLButtonElement>("#murky-picker-save")!;
  const cancelBtn = root.querySelector<HTMLButtonElement>("#murky-picker-cancel")!;

  function pickElementUnderPoint(x: number, y: number): HTMLElement | null {
    // Hide our overlay so elementFromPoint sees the page underneath.
    root.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    root.style.pointerEvents = "auto";
    if (!el || el === document.documentElement || el === document.body) return null;
    return el;
  }

  function highlight(el: HTMLElement | null): void {
    if (!el) {
      island.style.opacity = "0";
      return;
    }
    const rect = el.getBoundingClientRect();
    island.style.left = `${rect.left}px`;
    island.style.top = `${rect.top}px`;
    island.style.width = `${rect.width}px`;
    island.style.height = `${rect.height}px`;
    island.style.opacity = "1";
  }

  function showDialog(el: HTMLElement): void {
    state.frozen = true;
    state.ladder = buildLadder(el);
    state.rungIndex = state.ladder.recommendedIndex;
    dialog.style.display = "block";
    refreshDialog();
  }

  function refreshDialog(): void {
    if (!state.ladder) return;
    const rung = state.ladder.rungs[state.rungIndex];
    if (!rung) return;
    const matches = document.querySelectorAll(rung.chainedSelector);
    summary.innerHTML = `
      Selector: <code style="background:#fff; padding:1px 4px; border-radius:3px; font-size:11px; word-break:break-all;">${escapeHtml(rung.chainedSelector)}</code><br/>
      Matches <strong>${matches.length}</strong> element${matches.length === 1 ? "" : "s"} on this page.
    `;
    // Re-highlight the first match to give feedback as user climbs.
    highlight((matches[0] as HTMLElement | undefined) ?? null);
  }

  // -- Mouse/keyboard -----------------------------------------------------

  root.addEventListener("mousemove", (ev) => {
    if (state.frozen) return;
    const el = pickElementUnderPoint(ev.clientX, ev.clientY);
    state.hoverEl = el;
    highlight(el);
  });

  root.addEventListener(
    "click",
    (ev) => {
      if (state.frozen) return;
      ev.preventDefault();
      ev.stopPropagation();
      const el = pickElementUnderPoint(ev.clientX, ev.clientY);
      if (el) showDialog(el);
    },
    true
  );

  document.addEventListener("keydown", onKeyDown, true);

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      ev.preventDefault();
      teardown();
      return;
    }
    if (!state.frozen || !state.ladder) return;
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (state.rungIndex < state.ladder.rungs.length - 1) {
        state.rungIndex++;
        refreshDialog();
      }
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (state.rungIndex > 0) {
        state.rungIndex--;
        refreshDialog();
      }
    }
  }

  upBtn.addEventListener("click", () => {
    if (!state.ladder) return;
    if (state.rungIndex < state.ladder.rungs.length - 1) {
      state.rungIndex++;
      refreshDialog();
    }
  });
  downBtn.addEventListener("click", () => {
    if (!state.ladder) return;
    if (state.rungIndex > 0) {
      state.rungIndex--;
      refreshDialog();
    }
  });

  cancelBtn.addEventListener("click", teardown);

  saveBtn.addEventListener("click", async () => {
    if (!state.ladder) return;
    const rung = state.ladder.rungs[state.rungIndex];
    const origin = window.location.origin;
    await saveConfig({
      origin,
      cardSelector: rung.chainedSelector,
      label: labelInput.value.trim() || undefined,
      savedAt: Date.now(),
    });
    // Tell background to register a content script for this origin going
    // forward, then reload so masks attach immediately.
    chrome.runtime.sendMessage({
      type: "register-origin",
      origin,
    });
    teardown();
    location.reload();
  });

  function teardown(): void {
    document.removeEventListener("keydown", onKeyDown, true);
    root.remove();
  }

  // Pre-fill label with origin if a config already exists, just for context.
  void getConfig(window.location.origin).then((existing) => {
    if (existing?.label) labelInput.value = existing.label;
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Suppress unused-warning for originOf import (kept for future use of the
// helper from this file).
void originOf;
