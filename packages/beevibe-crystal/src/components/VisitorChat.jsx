import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!raw.startsWith("data: ")) continue;
      const payload = raw.slice(6);
      if (payload === "[DONE]") return;
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      onEvent(data.delta || "", data.error);
    }
  }
}

// Stable per-browser so the inbox can group one visitor's multi-turn convo.
function visitorSessionId() {
  try {
    let id = localStorage.getItem("cb_visitor_session");
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
        Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem("cb_visitor_session", id);
    }
    return id;
  } catch {
    return "anon";
  }
}

function VisitorChatInner({ capsule, onActivity }, ref) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [visitorName, setVisitorName] = useState(() => {
    try { return localStorage.getItem("cb_visitor_name") || ""; } catch { return ""; }
  });
  const endRef = useRef(null);

  // Notify the page so it can condense the brand area once a conversation starts.
  useEffect(() => {
    onActivity?.(messages.length);
  }, [messages.length, onActivity]);

  // Expose seedInput so the mind map can pre-fill the textarea when a
  // visitor clicks a node. Focuses the textarea so the cursor is ready.
  const textareaRef = useRef(null);
  useImperativeHandle(ref, () => ({
    seedInput(text) {
      setInput(text);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        const el = textareaRef.current;
        if (el) el.setSelectionRange(el.value.length, el.value.length);
      });
    },
  }));

  // Auto-scroll on new content. Streaming updates messages[last].text but the
  // message COUNT doesn't change, so also depend on the trailing char count to
  // keep the bottom in view as tokens arrive.
  const lastLen = messages[messages.length - 1]?.text?.length || 0;
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, lastLen]);

  function updateName(name) {
    const trimmed = name.slice(0, 40);
    setVisitorName(trimmed);
    try { localStorage.setItem("cb_visitor_name", trimmed); } catch {}
  }

  async function send(questionOverride) {
    const q = (questionOverride ?? input).trim();
    if (!q || busy) return;
    const prior = messages;
    setInput("");
    setError("");
    const next = [...messages, { role: "user", text: q }, { role: "assistant", text: "" }];
    setMessages(next);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capsule,
          history: next.slice(0, -1),
          sessionId: visitorSessionId(),
          visitorName: visitorName.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || `HTTP ${res.status}`);
      }
      await readSSE(res, (delta, errMsg) => {
        if (errMsg) throw new Error(errMsg);
        setMessages((m) => {
          const last = m[m.length - 1];
          if (!last || last.role !== "assistant") return m;
          const updated = m.slice(0, -1);
          updated.push({ role: "assistant", text: last.text + delta });
          return updated;
        });
      });
    } catch (e) {
      setMessages(prior);
      setInput(q);
      // Keep the technical detail (e.g. "server is missing ANTHROPIC_API_KEY")
      // in the console for debugging, but never surface it to a visitor.
      console.error("crystal chat failed:", e);
      setError("This capsule can't answer right now. Try again in a bit.");
    } finally {
      setBusy(false);
    }
  }

  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const empty = messages.length === 0;

  return (
    <>
      <div className="cb-chat-log">
        {empty ? (
          <div className="cb-chat-empty" />
        ) : (
          messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="cb-msg cb-msg-q">
                <div className="cb-msg-bubble">{m.text}</div>
              </div>
            ) : (
              <div key={i} className="cb-msg cb-msg-a">
                <div className="cb-msg-avatar" aria-hidden />
                <div className="cb-msg-stack">
                  <div className="cb-msg-label">crystal</div>
                  <div className="cb-msg-body">
                    {m.text ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                    ) : (
                      busy && i === messages.length - 1 && (
                        <span className="cb-streaming-cursor" aria-label="thinking" />
                      )
                    )}
                  </div>
                </div>
              </div>
            )
          )
        )}
        {error && <div className="cb-fail-text">{error}</div>}
        <div ref={endRef} aria-hidden />
      </div>

      <div className="cb-chat-dock">
        {empty && capsule.starters?.length > 0 && (
          <div className="cb-chat-dock-starters">
            {capsule.starters.map((s, i) => (
              <button
                key={i}
                className="cb-starter"
                onClick={() => send(s)}
                disabled={busy}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="cb-chat-dock-inner">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="ask the crystal…"
            rows={1}
          />
          <button onClick={() => send()} disabled={busy || !input.trim()} aria-label="Ask">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="5" y1="12" x2="19" y2="12"/>
              <polyline points="12 5 19 12 12 19"/>
            </svg>
          </button>
        </div>
        <div className="cb-chat-author-line">
          asking as{" "}
          <input
            className="cb-chat-author"
            type="text"
            placeholder="anonymous"
            value={visitorName}
            onChange={(e) => updateName(e.target.value)}
            maxLength={40}
          />
        </div>
      </div>
    </>
  );
}

const VisitorChat = forwardRef(VisitorChatInner);
export default VisitorChat;
