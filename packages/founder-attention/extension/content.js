(() => {
  if (window.__faInjected) return;
  window.__faInjected = true;

  const STATUS_RE = /\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;

  function parseTweetArticle(article) {
    const links = article.querySelectorAll('a[href*="/status/"]');
    let url = null;
    let id = null;
    let handle = null;
    for (const a of links) {
      const m = a.getAttribute("href")?.match(STATUS_RE);
      if (m) {
        handle = m[1];
        id = m[2];
        url = "https://x.com" + a.getAttribute("href").split("?")[0];
        break;
      }
    }
    if (!id) return null;

    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = textEl ? textEl.innerText.trim() : "";
    if (!text) return null;

    const nameEl = article.querySelector('[data-testid="User-Name"]');
    const author_name = nameEl ? nameEl.innerText.split("\n")[0].trim() : null;

    const timeEl = article.querySelector("time");
    const posted_at_iso = timeEl?.getAttribute("datetime") || null;

    const stats = {};
    for (const el of article.querySelectorAll('[data-testid$="-count"], [aria-label*="repl"], [aria-label*="like"]')) {
      const tid = el.getAttribute("data-testid") || "";
      const aria = el.getAttribute("aria-label") || "";
      if (tid.includes("reply") || aria.includes("repl")) {
        const n = parseInt((aria.match(/\d[\d,]*/) || [])[0]?.replace(/,/g, "") || "0", 10);
        if (!Number.isNaN(n)) stats.reply_count = n;
      }
      if (tid.includes("like") || aria.includes("like")) {
        const n = parseInt((aria.match(/\d[\d,]*/) || [])[0]?.replace(/,/g, "") || "0", 10);
        if (!Number.isNaN(n)) stats.like_count = n;
      }
    }

    return {
      id,
      url,
      author_handle: "@" + handle,
      author_name,
      text,
      posted_at_iso,
      ...stats,
    };
  }

  function scanVisibleTweets() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const seen = new Set();
    const tweets = [];
    for (const a of articles) {
      const t = parseTweetArticle(a);
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      tweets.push(t);
      if (tweets.length >= 25) break;
    }
    return tweets;
  }

  function styleScoreBadge(score) {
    if (score >= 8) return "fa-score fa-score-hot";
    if (score >= 6) return "fa-score fa-score-warm";
    return "fa-score fa-score-cold";
  }

  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    for (const c of [].concat(children)) {
      if (c == null) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }

  async function copyAndOpen(draft, url) {
    try {
      await navigator.clipboard.writeText(draft);
    } catch (_) {}
    window.open(url, "_blank", "noopener");
  }

  function renderResults(panel, tweets, response) {
    const byId = new Map(tweets.map((t) => [t.id, t]));
    panel.querySelector(".fa-list").innerHTML = "";

    const meta = panel.querySelector(".fa-meta");
    meta.textContent = `${response.results.length} scanned · model ${response.model} · cache ${response.cached_input_tokens}t`;

    const top = response.results.filter((r) => r.score >= 6);
    if (top.length === 0) {
      panel.querySelector(".fa-list").appendChild(
        el("div", { className: "fa-empty" }, "No tweets cleared the score >= 6 bar in this batch. Scroll, then scan again.")
      );
      return;
    }

    for (const r of top) {
      const t = byId.get(r.tweet_id);
      if (!t) continue;
      const card = el("div", { className: "fa-card" });
      const head = el("div", { className: "fa-head" }, [
        el("span", { className: styleScoreBadge(r.score), textContent: String(r.score) }),
        el("span", { className: "fa-author", textContent: `${t.author_name || ""} ${t.author_handle}`.trim() }),
        r.in_golden_window
          ? el("span", { className: "fa-tag", textContent: "golden window" })
          : null,
      ]);
      const why = el("div", { className: "fa-why", textContent: r.why });
      const preview = el("div", { className: "fa-preview", textContent: t.text });

      const drafts = el("div", { className: "fa-drafts" });
      for (const [key, label] of [
        ["witty", "Witty"],
        ["insightful", "Insightful"],
        ["sincere", "Sincere"],
      ]) {
        const draft = r.drafts?.[key];
        if (!draft) continue;
        const btn = el("button", { className: "fa-draft-btn", title: "Copy + open tweet" });
        btn.appendChild(el("span", { className: "fa-draft-label", textContent: label }));
        btn.appendChild(el("span", { className: "fa-draft-text", textContent: draft }));
        btn.addEventListener("click", () => copyAndOpen(draft, t.url));
        drafts.appendChild(btn);
      }

      card.appendChild(head);
      card.appendChild(preview);
      card.appendChild(why);
      card.appendChild(drafts);
      panel.querySelector(".fa-list").appendChild(card);
    }
  }

  function mountPanel() {
    const existing = document.getElementById("fa-panel");
    if (existing) return existing;

    const panel = el("div", { id: "fa-panel", className: "fa-collapsed" });
    panel.innerHTML = `
      <div class="fa-header">
        <span class="fa-title">Founder Attention</span>
        <span class="fa-meta"></span>
        <button class="fa-btn-scan" type="button">Scan feed</button>
        <button class="fa-btn-toggle" type="button" aria-label="toggle">−</button>
      </div>
      <div class="fa-status"></div>
      <div class="fa-list"></div>
    `;
    document.body.appendChild(panel);

    panel.querySelector(".fa-btn-toggle").addEventListener("click", () => {
      panel.classList.toggle("fa-collapsed");
      panel.querySelector(".fa-btn-toggle").textContent =
        panel.classList.contains("fa-collapsed") ? "+" : "−";
    });

    panel.querySelector(".fa-btn-scan").addEventListener("click", async () => {
      const status = panel.querySelector(".fa-status");
      const tweets = scanVisibleTweets();
      if (tweets.length === 0) {
        status.textContent = "No tweets found on screen. Scroll the timeline and try again.";
        return;
      }
      status.textContent = `Scoring ${tweets.length} tweets…`;
      panel.classList.remove("fa-collapsed");
      try {
        const reply = await chrome.runtime.sendMessage({
          type: "fa.rankAndDraft",
          tweets,
        });
        if (!reply?.ok) {
          status.textContent = `Backend error: ${reply?.error || "unknown"}`;
          return;
        }
        status.textContent = "";
        renderResults(panel, tweets, reply.data);
      } catch (e) {
        status.textContent = `Request failed: ${e}`;
      }
    });

    return panel;
  }

  function ensureMounted() {
    if (document.body) mountPanel();
    else window.addEventListener("DOMContentLoaded", mountPanel, { once: true });
  }

  ensureMounted();
})();
