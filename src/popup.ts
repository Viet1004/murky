import { CollectionData, MaskLevel } from "./types";
import {
  listCollections,
  CollectionSummary,
  getAuthToken,
  getAuthEmail,
  getServerUrl,
} from "./packs";

const enableToggle = document.getElementById(
  "enableToggle"
) as HTMLInputElement;
const levelSelect = document.getElementById(
  "levelSelect"
) as HTMLSelectElement;
const packSelect = document.getElementById("packSelect") as HTMLSelectElement;
const reloadPacksBtn = document.getElementById(
  "reloadPacksBtn"
) as HTMLButtonElement;
const serverUrlInput = document.getElementById(
  "serverUrlInput"
) as HTMLInputElement;
const resetBtn = document.getElementById("resetBtn") as HTMLButtonElement;
const exportBtn = document.getElementById("exportBtn") as HTMLButtonElement;
const clearDataBtn = document.getElementById(
  "clearDataBtn"
) as HTMLButtonElement;
const status = document.getElementById("status") as HTMLDivElement;
const eventCount = document.getElementById("eventCount") as HTMLSpanElement;

// Auth elements
const loggedOutDiv = document.getElementById("loggedOut") as HTMLDivElement;
const loggedInDiv = document.getElementById("loggedIn") as HTMLDivElement;
const browseBtn = document.getElementById("browseBtn") as HTMLButtonElement;
const logoutBtn = document.getElementById("logoutBtn") as HTMLButtonElement;
const userEmailSpan = document.getElementById("userEmail") as HTMLDivElement;

const DEFAULT_SERVER_URL = "http://localhost:8000";

// ---------- Auth ----------

async function updateAuthUI(): Promise<void> {
  const token = await getAuthToken();
  if (token) {
    const email = await getAuthEmail();
    userEmailSpan.textContent = email ? `Signed in as ${email}` : "Signed in";
    loggedOutDiv.style.display = "none";
    loggedInDiv.style.display = "block";
  } else {
    loggedOutDiv.style.display = "block";
    loggedInDiv.style.display = "none";
  }
}

browseBtn.addEventListener("click", async () => {
  const base = await getServerUrl();
  const url = `${base}/browse?ext=${encodeURIComponent(chrome.runtime.id)}`;
  chrome.tabs.create({ url }, () => window.close());
});

logoutBtn.addEventListener("click", async () => {
  chrome.storage.local.remove(["murkyAuthToken", "murkyAuthEmail"], () => {
    status.textContent = "Signed out";
    updateAuthUI();
  });
});

// ---------- Load current state ----------

chrome.storage.local.get(
  [
    "murkyEnabled",
    "murkyCollection",
    "murkyMaskLevel",
    "murkyActivePack",
    "murkyServerUrl",
  ],
  (result: { [key: string]: unknown }) => {
    const enabled = result.murkyEnabled !== false;
    enableToggle.checked = enabled;
    status.textContent = enabled ? "Masking active" : "Masking paused";

    const level = (result.murkyMaskLevel as MaskLevel | undefined) ?? "full";
    levelSelect.value = level;

    serverUrlInput.value =
      (result.murkyServerUrl as string | undefined) ?? DEFAULT_SERVER_URL;

    const collection = result.murkyCollection as CollectionData | undefined;
    updateEventCount(collection);

    const activeSlug = (result.murkyActivePack as string | undefined) ?? "";
    refreshPackList(activeSlug);
  }
);

updateAuthUI();

async function refreshPackList(activeSlug: string): Promise<void> {
  // Reset to just the local fallback option first.
  packSelect.innerHTML = '<option value="">Bundled (local)</option>';
  try {
    const collections: CollectionSummary[] = await listCollections();
    for (const c of collections) {
      const opt = document.createElement("option");
      opt.value = c.slug;
      opt.textContent = `${c.display_name} (${c.theme_count} themes)`;
      packSelect.appendChild(opt);
    }
    packSelect.value = activeSlug;
  } catch (e) {
    console.warn("[murky popup] failed to list collections", e);
    status.textContent = "Server unreachable";
  }
}

packSelect.addEventListener("change", () => {
  const slug = packSelect.value;
  chrome.storage.local.set({ murkyActivePack: slug || null }, () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId !== undefined) chrome.tabs.reload(tabId);
    });
  });
  status.textContent = slug ? `Pack: ${slug}` : "Pack: bundled";
});

reloadPacksBtn.addEventListener("click", () => {
  const activeSlug = (packSelect.value as string | undefined) ?? "";
  refreshPackList(activeSlug);
});

serverUrlInput.addEventListener("change", () => {
  const url = serverUrlInput.value.trim() || DEFAULT_SERVER_URL;
  chrome.storage.local.set({ murkyServerUrl: url }, () => {
    refreshPackList(packSelect.value);
  });
  status.textContent = `Server: ${url}`;
});

levelSelect.addEventListener("change", () => {
  const level = levelSelect.value as MaskLevel;
  chrome.storage.local.set({ murkyMaskLevel: level });
  status.textContent = `Mask level: ${level}`;
});

function updateEventCount(collection?: CollectionData): void {
  const count = collection?.events.length ?? 0;
  eventCount.textContent = `${count} events collected`;
}

enableToggle.addEventListener("change", () => {
  const enabled = enableToggle.checked;
  status.textContent = enabled ? "Enabling..." : "Disabling...";
  chrome.storage.local.set({ murkyEnabled: enabled }, () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId !== undefined) chrome.tabs.reload(tabId);
    });
  });
});

resetBtn.addEventListener("click", () => {
  chrome.storage.local.set({ murkyRevealed: [] });
  status.textContent = "All cards re-masked";

  setTimeout(() => {
    status.textContent = enableToggle.checked
      ? "Masking active"
      : "Masking paused";
  }, 1500);
});

exportBtn.addEventListener("click", () => {
  chrome.storage.local.get(["murkyCollection"], (result) => {
    const collection = result.murkyCollection as CollectionData | undefined;
    const data = collection ?? { events: [], sessionCount: 0 };

    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `murky-data-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    status.textContent = `Exported ${data.events.length} events`;
    setTimeout(() => {
      status.textContent = enableToggle.checked
        ? "Masking active"
        : "Masking paused";
    }, 2000);
  });
});

clearDataBtn.addEventListener("click", () => {
  chrome.storage.local.set({
    murkyCollection: { events: [], sessionCount: 0 },
  });
  updateEventCount();
  status.textContent = "Data cleared";
  setTimeout(() => {
    status.textContent = enableToggle.checked
      ? "Masking active"
      : "Masking paused";
  }, 1500);
});
