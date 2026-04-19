/**
 * Background service worker.
 *
 * Proxies fetch requests from content scripts / popup so they aren't
 * subject to the page's CORS / Private Network Access restrictions.
 *
 * Message types:
 *   { type: "fetch", url, headers? }           — GET request
 *   { type: "fetch-post", url, headers?, body } — POST request (string body)
 */

const ALLOWED_EXTERNAL_ORIGIN = "http://localhost:8000";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "fetch" || message.type === "fetch-post") {
    const isPost = message.type === "fetch-post";
    const fetchOptions: RequestInit = {
      method: isPost ? "POST" : "GET",
    };
    if (message.headers) {
      fetchOptions.headers = message.headers;
    }
    if (isPost && message.body) {
      fetchOptions.body = message.body;
    }
    fetch(message.url, fetchOptions)
      .then((res) => {
        if (!res.ok) {
          return res.text().then((text) => {
            throw new Error(`HTTP ${res.status}: ${text}`);
          });
        }
        return res.json();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (sender.origin !== ALLOWED_EXTERNAL_ORIGIN) {
    console.warn("[murky background] rejected external message", {
      origin: sender.origin,
      type: message?.type,
    });
    sendResponse({ ok: false, error: "origin not allowed" });
    return false;
  }

  if (message?.type === "auth-token") {
    const token = typeof message.token === "string" ? message.token : "";
    const email = typeof message.email === "string" ? message.email : "";

    if (!token) {
      sendResponse({ ok: false, error: "missing token" });
      return false;
    }

    chrome.storage.local.set(
      {
        murkyAuthToken: token,
        murkyAuthEmail: email || null,
      },
      () => sendResponse({ ok: true })
    );
    return true;
  }

  console.warn("[murky background] unknown external message", {
    origin: sender.origin,
    type: message?.type,
  });
  sendResponse({ ok: false, error: "unknown message type" });
  return false;
});
