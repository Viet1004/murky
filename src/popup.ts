import {
  getAuthToken,
  getAuthEmail,
  getServerUrl,
  getActiveSlug,
  listMyLicenses,
  LicenseInfo,
} from "./packs";

import {
  loadStore,
  deleteConfig,
  originOf,
  SiteSelectorConfig,
} from "./picker/store";

const enableToggle = document.getElementById("enableToggle") as HTMLInputElement;
const serverUrlInput = document.getElementById("serverUrlInput") as HTMLInputElement;
const browseBtn = document.getElementById("browseBtn") as HTMLButtonElement;
const browseSignedInBtn = document.getElementById("browseSignedInBtn") as HTMLButtonElement;
const studioBtn = document.getElementById("studioBtn") as HTMLButtonElement;
const logoutBtn = document.getElementById("logoutBtn") as HTMLButtonElement;
const userEmail = document.getElementById("userEmail") as HTMLDivElement;
const signedIn = document.getElementById("signedIn") as HTMLDivElement;
const signedOut = document.getElementById("signedOut") as HTMLDivElement;
const syncToggle = document.getElementById("syncToggle") as HTMLInputElement;
const syncGatedNote = document.getElementById("syncGatedNote") as HTMLDivElement;
const clearSyncBtn = document.getElementById("clearSyncBtn") as HTMLButtonElement;
const premiumFilterToggle = document.getElementById("premiumFilterToggle") as HTMLInputElement;
const premiumGatedNote = document.getElementById("premiumGatedNote") as HTMLDivElement;
const statusDot = document.getElementById("statusDot") as HTMLSpanElement;
const statusLabel = document.getElementById("statusLabel") as HTMLSpanElement;
const statusMeta = document.getElementById("statusMeta") as HTMLDivElement;
const behaviorToggle = document.getElementById("behaviorToggle") as HTMLInputElement;
const clearBehaviorBtn = document.getElementById("clearBehaviorBtn") as HTMLButtonElement;
const focusPromptInput = document.getElementById("focusPromptInput") as HTMLTextAreaElement;
const scorerSelect = document.getElementById("scorerSelect") as HTMLSelectElement;
const pickElementBtn = document.getElementById("pickElementBtn") as HTMLButtonElement;
const forgetSiteBtn = document.getElementById("forgetSiteBtn") as HTMLButtonElement;
const pickerStatus = document.getElementById("pickerStatus") as HTMLDivElement;
const savedSitesHeader = document.getElementById("savedSitesHeader") as HTMLButtonElement;
const savedSitesSummary = document.getElementById("savedSitesSummary") as HTMLDivElement;
const savedSitesChevron = document.getElementById("savedSitesChevron") as HTMLSpanElement;
const savedSitesList = document.getElementById("savedSitesList") as HTMLDivElement;

const DEFAULT_SERVER_URL = "http://localhost:5173";
const DEFAULT_SCORER_ID = "random";

interface UserProfile {
  prompt?: string;
  blockedKeywords?: string[];
  focusKeywords?: string[];
  budgetCeilingVnd?: number;
}

// ---------- Initial state ----------

chrome.storage.local.get(
  [
    "murkyEnabled",
    "murkyServerUrl",
    "murkyBehaviorEnabled",
    "murkyProfile",
    "murkyScorerId",
    "murkySyncEnabled",
  ],
  (result) => {
    enableToggle.checked = result.murkyEnabled !== false;
    serverUrlInput.value =
      (result.murkyServerUrl as string | undefined) ?? DEFAULT_SERVER_URL;
    behaviorToggle.checked = result.murkyBehaviorEnabled === true;
    syncToggle.checked = result.murkySyncEnabled === true;
    const profile = (result.murkyProfile as UserProfile | undefined) ?? {};
    focusPromptInput.value = profile.prompt ?? "";
    scorerSelect.value =
      (result.murkyScorerId as string | undefined) ?? DEFAULT_SCORER_ID;
    refreshStatus();
  }
);

// ---------- Status ----------

function setStatus(kind: "connected" | "local" | "off", label: string, meta = ""): void {
  statusDot.className = `dot ${kind === "off" ? "" : kind}`;
  statusLabel.textContent = label;
  statusMeta.textContent = meta;
}

async function refreshStatus(): Promise<void> {
  const token = await getAuthToken();
  const signed = Boolean(token);

  // Auth UI: flip between signed-in and signed-out blocks inside the
  // account card.
  if (signed) {
    const email = await getAuthEmail();
    userEmail.textContent = email ? `Signed in as ${email}` : "Signed in";
    signedIn.style.display = "block";
    signedOut.style.display = "none";
  } else {
    signedIn.style.display = "none";
    signedOut.style.display = "block";
  }

  // Gate online add-on toggles on auth state.
  syncToggle.disabled = !signed;
  syncGatedNote.style.display = signed ? "none" : "block";
  if (!signed) syncToggle.checked = false;

  premiumFilterToggle.disabled = true; // always disabled — coming soon
  premiumGatedNote.textContent = signed
    ? "Coming soon — server-side filter not yet available."
    : "Sign in to enable the online filter.";
  premiumGatedNote.style.display = "block";

  if (!enableToggle.checked) {
    setStatus("off", "Masking paused", "Toggle on to start masking products.");
    return;
  }

  if (!signed) {
    setStatus("local", "Offline", "Local masking is on. Sign in to add online collections.");
    return;
  }

  // Signed in: try to read which collection is active.
  try {
    const [activeSlug, licenses] = await Promise.all([
      getActiveSlug(),
      listMyLicenses().catch(() => [] as LicenseInfo[]),
    ]);
    const active = licenses.find((l) => l.collection_slug === activeSlug);
    if (active) {
      setStatus("connected", "Connected to server", `Loaded: ${active.collection_name}`);
    } else if (licenses.length > 0) {
      setStatus("connected", "Connected to server", "Pick a collection from Browse.");
    } else {
      setStatus("connected", "Connected to server", "No collections yet — browse to get one.");
    }
  } catch {
    setStatus("local", "Server unreachable", "Falling back to bundled local masks.");
  }
}

// ---------- Events ----------

enableToggle.addEventListener("change", () => {
  chrome.storage.local.set({ murkyEnabled: enableToggle.checked }, () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId !== undefined) chrome.tabs.reload(tabId);
    });
    refreshStatus();
  });
});

serverUrlInput.addEventListener("change", () => {
  const url = serverUrlInput.value.trim() || DEFAULT_SERVER_URL;
  chrome.storage.local.set({ murkyServerUrl: url }, refreshStatus);
});

async function openBrowse(): Promise<void> {
  const base = await getServerUrl();
  chrome.tabs.create(
    { url: `${base}/browse?ext=${encodeURIComponent(chrome.runtime.id)}` },
    () => window.close()
  );
}

browseBtn.addEventListener("click", openBrowse);
browseSignedInBtn.addEventListener("click", openBrowse);

studioBtn.addEventListener("click", async () => {
  const base = await getServerUrl();
  chrome.tabs.create(
    { url: `${base}/studio?ext=${encodeURIComponent(chrome.runtime.id)}` },
    () => window.close()
  );
});

// ---------- Sync toggle (Tier 3 — opt-in cross-device sync) ----------

syncToggle.addEventListener("change", async () => {
  const enabled = syncToggle.checked;
  await new Promise<void>((resolve) =>
    chrome.storage.local.set({ murkySyncEnabled: enabled }, () => resolve())
  );
  // Tell background to push / pull immediately when newly enabled, or
  // stop scheduled pushes when disabled. The handler is a no-op until the
  // sync subsystem lands; this wiring is forward-compatible.
  chrome.runtime.sendMessage({ type: "sync-toggle", enabled });
});

clearSyncBtn.addEventListener("click", async () => {
  if (!window.confirm("Delete all synced masks and preferences from the server?")) return;
  clearSyncBtn.disabled = true;
  clearSyncBtn.textContent = "Deleting…";
  try {
    await new Promise<void>((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "sync-clear" }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response?.ok) reject(new Error(response?.error ?? "clear failed"));
        else resolve();
      });
    });
    clearSyncBtn.textContent = "Deleted ✓";
  } catch (e) {
    console.warn("[murky] sync clear failed", e);
    clearSyncBtn.textContent = "Failed — try again";
  } finally {
    setTimeout(() => {
      clearSyncBtn.disabled = false;
      clearSyncBtn.textContent = "Delete sync data";
    }, 1500);
  }
});

// ---------- Disclosure expand/collapse ("What gets sent?") -----------

document.querySelectorAll<HTMLButtonElement>(".disclosure-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.target;
    if (!targetId) return;
    const body = document.getElementById(targetId);
    if (!body) return;
    const open = body.style.display === "block";
    body.style.display = open ? "none" : "block";
    btn.textContent = open ? "What gets sent?" : "Hide details";
  });
});

logoutBtn.addEventListener("click", () => {
  // Sign-out returns the extension to a pure-offline state. Clear the
  // active collection slug too so the content script stops fetching
  // online masks; bundled local masks take over on next reload.
  chrome.storage.local.remove(
    [
      "murkyAuthToken",
      "murkyAuthEmail",
      "murkyAuthRefreshToken",
      "murkyAuthExpiresAt",
      "murkyActivePack",
      "murkyCollectionCache",
    ],
    refreshStatus
  );
});

// ---------- Focus prompt + scorer model ----------

function reloadActiveTab(): void {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (tabId !== undefined) chrome.tabs.reload(tabId);
  });
}

focusPromptInput.addEventListener("change", () => {
  chrome.storage.local.get(["murkyProfile"], (r) => {
    const existing = (r.murkyProfile as UserProfile | undefined) ?? {};
    const next: UserProfile = { ...existing, prompt: focusPromptInput.value.trim() || undefined };
    chrome.storage.local.set({ murkyProfile: next }, reloadActiveTab);
  });
});

scorerSelect.addEventListener("change", () => {
  chrome.storage.local.set({ murkyScorerId: scorerSelect.value }, reloadActiveTab);
});

// ---------- Picker (universal element picker) ----------

async function refreshPickerStatus(): Promise<void> {
  const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, resolve)
  );
  const tab = tabs[0];
  const url = tab?.url ?? "";
  if (!/^https?:/.test(url)) {
    pickElementBtn.disabled = true;
    pickerStatus.style.display = "block";
    pickerStatus.textContent = "Picker only works on http(s) pages.";
    forgetSiteBtn.style.display = "none";
    return;
  }
  pickElementBtn.disabled = false;
  const origin = originOf(url);
  const store = await loadStore();
  const config = store[origin];
  if (config) {
    pickerStatus.style.display = "block";
    const label = config.label ?? new URL(origin).hostname;
    pickerStatus.textContent = `Active on ${label}: masking elements matching the saved selector.`;
    forgetSiteBtn.style.display = "block";
  } else {
    pickerStatus.style.display = "block";
    pickerStatus.textContent = `No selector saved for ${new URL(origin).hostname}. Click "Pick element" and choose a card.`;
    forgetSiteBtn.style.display = "none";
  }
}

pickElementBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "run-picker" }, (response) => {
    if (chrome.runtime.lastError) {
      pickerStatus.style.display = "block";
      pickerStatus.textContent = `Failed: ${chrome.runtime.lastError.message}`;
      return;
    }
    if (!response?.ok) {
      pickerStatus.style.display = "block";
      pickerStatus.textContent = `Failed: ${response?.error ?? "unknown error"}`;
      return;
    }
    window.close();
  });
});

forgetSiteBtn.addEventListener("click", async () => {
  const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, resolve)
  );
  const url = tabs[0]?.url ?? "";
  const origin = originOf(url);
  if (!origin) return;
  await deleteConfig(origin);
  if (tabs[0]?.id !== undefined) chrome.tabs.reload(tabs[0].id);
  await refreshPickerStatus();
  await refreshSavedSites();
});

void refreshPickerStatus();
void refreshSavedSites();

// ---------- Saved sites manager ----------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

async function refreshSavedSites(): Promise<void> {
  const store = await loadStore();
  const configs: SiteSelectorConfig[] = Object.values(store).sort(
    (a, b) => b.savedAt - a.savedAt
  );
  if (configs.length === 0) {
    savedSitesSummary.textContent = "No sites saved yet.";
  } else {
    savedSitesSummary.textContent = `${configs.length} site${configs.length === 1 ? "" : "s"} masked automatically on revisit.`;
  }
  renderSavedSitesList(configs);
}

function renderSavedSitesList(configs: SiteSelectorConfig[]): void {
  if (configs.length === 0) {
    savedSitesList.innerHTML = `<div class="meta">Use "Pick element" on any site to add it here.</div>`;
    return;
  }
  savedSitesList.innerHTML = configs
    .map((c) => {
      const host = (() => {
        try {
          return new URL(c.origin).hostname;
        } catch {
          return c.origin;
        }
      })();
      const label = c.label?.trim() || host;
      return `
        <div class="saved-site" data-origin="${escapeHtml(c.origin)}" style="display:flex; align-items:center; gap:6px; padding:8px 0; border-top:1px solid var(--cream-dark);">
          <div style="flex:1; min-width:0;">
            <div style="font-size:12px; font-weight:500; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(label)}</div>
            <div class="meta" style="margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(host)} • saved ${relativeTime(c.savedAt)}</div>
          </div>
          <button class="btn saved-visit" data-origin="${escapeHtml(c.origin)}" style="padding:4px 10px; font-size:11px; flex:0 0 auto; width:auto;">Visit</button>
          <button class="btn saved-forget" data-origin="${escapeHtml(c.origin)}" style="padding:4px 10px; font-size:11px; flex:0 0 auto; width:auto;">Forget</button>
        </div>
      `;
    })
    .join("");

  savedSitesList.querySelectorAll<HTMLButtonElement>(".saved-visit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const origin = btn.dataset.origin;
      if (!origin) return;
      chrome.tabs.create({ url: origin }, () => window.close());
    });
  });
  savedSitesList.querySelectorAll<HTMLButtonElement>(".saved-forget").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const origin = btn.dataset.origin;
      if (!origin) return;
      const host = (() => {
        try { return new URL(origin).hostname; } catch { return origin; }
      })();
      if (!window.confirm(`Forget masks on ${host}?`)) return;
      await deleteConfig(origin);
      chrome.runtime.sendMessage({ type: "unregister-origin", origin });
      await refreshSavedSites();
      await refreshPickerStatus();
    });
  });
}

savedSitesHeader.addEventListener("click", () => {
  const open = savedSitesList.style.display !== "none";
  savedSitesList.style.display = open ? "none" : "block";
  savedSitesChevron.textContent = open ? "▸" : "▾";
});

// ---------- Behavior collection toggle ----------

behaviorToggle.addEventListener("change", () => {
  chrome.storage.local.set({ murkyBehaviorEnabled: behaviorToggle.checked });
});

clearBehaviorBtn.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Delete all collected behavior data from the server? This cannot be undone."
  );
  if (!confirmed) return;

  const base = (serverUrlInput.value.trim() || DEFAULT_SERVER_URL).replace(
    /\/$/,
    ""
  );
  const { murkyAnonId } = await new Promise<{ murkyAnonId?: string }>(
    (resolve) => {
      chrome.storage.local.get(["murkyAnonId"], (r) =>
        resolve(r as { murkyAnonId?: string })
      );
    }
  );

  clearBehaviorBtn.disabled = true;
  clearBehaviorBtn.textContent = "Clearing…";
  try {
    await new Promise<void>((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "fetch-post",
          url: `${base}/behavior/clear`,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anon_id: murkyAnonId ?? null }),
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!response?.ok) {
            reject(new Error(response?.error ?? "clear failed"));
          } else {
            resolve();
          }
        }
      );
    });
    clearBehaviorBtn.textContent = "Cleared ✓";
  } catch (e) {
    console.warn("[murky] clear failed", e);
    clearBehaviorBtn.textContent = "Failed — try again";
  } finally {
    setTimeout(() => {
      clearBehaviorBtn.disabled = false;
      clearBehaviorBtn.textContent = "Clear my behavior data";
    }, 1500);
  }
});
