const DEFAULT_BACKEND = "http://localhost:8787";

async function getBackendUrl() {
  const { backendUrl } = await chrome.storage.local.get("backendUrl");
  return (backendUrl && backendUrl.trim()) || DEFAULT_BACKEND;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "fa.rankAndDraft") return false;

  (async () => {
    try {
      const base = await getBackendUrl();
      const resp = await fetch(base.replace(/\/$/, "") + "/api/rank-and-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tweets: msg.tweets }),
      });
      const text = await resp.text();
      if (!resp.ok) {
        sendResponse({ ok: false, status: resp.status, error: text });
        return;
      }
      sendResponse({ ok: true, data: JSON.parse(text) });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true;
});
