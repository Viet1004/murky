import {
  getAuthToken,
  getAuthEmail,
  getServerUrl,
  getActiveSlug,
  listMyLicenses,
  LicenseInfo,
} from "./packs";

const enableToggle = document.getElementById("enableToggle") as HTMLInputElement;
const serverUrlInput = document.getElementById("serverUrlInput") as HTMLInputElement;
const browseBtn = document.getElementById("browseBtn") as HTMLButtonElement;
const studioBtn = document.getElementById("studioBtn") as HTMLButtonElement;
const logoutBtn = document.getElementById("logoutBtn") as HTMLButtonElement;
const userEmail = document.getElementById("userEmail") as HTMLDivElement;
const signedIn = document.getElementById("signedIn") as HTMLDivElement;
const statusDot = document.getElementById("statusDot") as HTMLSpanElement;
const statusLabel = document.getElementById("statusLabel") as HTMLSpanElement;
const statusMeta = document.getElementById("statusMeta") as HTMLDivElement;
const behaviorToggle = document.getElementById("behaviorToggle") as HTMLInputElement;
const clearBehaviorBtn = document.getElementById("clearBehaviorBtn") as HTMLButtonElement;

const DEFAULT_SERVER_URL = "http://localhost:8000";

// ---------- Initial state ----------

chrome.storage.local.get(
  ["murkyEnabled", "murkyServerUrl", "murkyBehaviorEnabled"],
  (result) => {
    enableToggle.checked = result.murkyEnabled !== false;
    serverUrlInput.value =
      (result.murkyServerUrl as string | undefined) ?? DEFAULT_SERVER_URL;
    behaviorToggle.checked = result.murkyBehaviorEnabled === true;
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

  // Auth UI
  if (signed) {
    const email = await getAuthEmail();
    userEmail.textContent = email ? `Signed in as ${email}` : "Signed in";
    signedIn.style.display = "block";
  } else {
    signedIn.style.display = "none";
  }

  if (!enableToggle.checked) {
    setStatus("off", "Masking paused", "Toggle on to start masking products.");
    return;
  }

  if (!signed) {
    setStatus("local", "Local masks only", "Sign in to load community collections.");
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

browseBtn.addEventListener("click", async () => {
  const base = await getServerUrl();
  chrome.tabs.create(
    { url: `${base}/browse?ext=${encodeURIComponent(chrome.runtime.id)}` },
    () => window.close()
  );
});

studioBtn.addEventListener("click", async () => {
  const base = await getServerUrl();
  chrome.tabs.create(
    { url: `${base}/studio?ext=${encodeURIComponent(chrome.runtime.id)}` },
    () => window.close()
  );
});

logoutBtn.addEventListener("click", () => {
  chrome.storage.local.remove(
    [
      "murkyAuthToken",
      "murkyAuthEmail",
      "murkyAuthRefreshToken",
      "murkyAuthExpiresAt",
    ],
    refreshStatus
  );
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
