import { useEffect, useRef, useState } from "react";

// Controlled body — Capsule.jsx owns the open/closed state and renders the
// toggle in the page header. Pass `open=false` to render nothing.
export default function VisitInbox({ capsuleId, open }) {
  const [status, setStatus] = useState("idle"); // idle | loading | ok | error
  const [visits, setVisits] = useState([]);
  const [error, setError] = useState("");
  const fetched = useRef(false);

  useEffect(() => {
    if (!open || fetched.current) return;
    fetched.current = true;
    setStatus("loading");
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/capsules/${capsuleId}/visits`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        setVisits(json.visits || []);
        setStatus("ok");
      } catch (e) {
        if (cancelled) return;
        setError(e.message || String(e));
        setStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [open, capsuleId]);

  function appendReply(entry) {
    setVisits((v) => [...v, entry]);
  }

  if (!open) return null;

  const sessions = groupSessions(visits);

  return (
    <div className="cb-inbox">
      <InboxBody
        status={status}
        sessions={sessions}
        error={error}
        capsuleId={capsuleId}
        onReply={appendReply}
      />
    </div>
  );
}

function InboxBody({ status, sessions, error, capsuleId, onReply }) {
  if (status === "error") {
    return <div className="cb-inbox-body cb-fail-text">Couldn't load: {error}</div>;
  }
  if (status === "loading" || status === "idle") {
    return <div className="cb-inbox-body cb-dim">loading…</div>;
  }
  if (sessions.length === 0) {
    return (
      <div className="cb-inbox-body cb-dim cb-inbox-empty">
        No one has asked the capsule anything yet. When they do, you'll see
        their questions here.
      </div>
    );
  }
  return (
    <div className="cb-inbox-body">
      <div className="cb-inbox-list">
        {sessions.map((s, i) => (
          <SessionBlock
            key={s.id}
            session={s}
            index={sessions.length - i}
            capsuleId={capsuleId}
            onReply={onReply}
          />
        ))}
      </div>
    </div>
  );
}

function SessionBlock({ session, index, capsuleId, onReply }) {
  const label = session.visitorName?.trim() || `visitor ${index}`;
  return (
    <div className="cb-inbox-session">
      <div className="cb-inbox-session-head">
        <span>{label}</span>
        <span aria-hidden>·</span>
        <span>{relTime(session.lastTs)}</span>
      </div>
      <div className="cb-inbox-pairs">
        {session.pairs.map((p, i) => (
          <Pair key={i} pair={p} capsuleId={capsuleId} onReply={onReply} />
        ))}
      </div>
    </div>
  );
}

function Pair({ pair, capsuleId, onReply }) {
  const [replying, setReplying] = useState(false);
  return (
    <div className="cb-inbox-pair-block">
      {pair.question && (
        <div className="cb-inbox-q">
          <span className="cb-inbox-role">Q</span>
          <div>{pair.question}</div>
        </div>
      )}
      {pair.answer && (
        <div className="cb-inbox-a">
          <span className="cb-inbox-role">A</span>
          <div>{pair.answer}</div>
        </div>
      )}
      {pair.replies.map((r, i) => (
        <div key={i} className="cb-inbox-reply">
          <span className="cb-inbox-role">↳</span>
          <div>
            <div className="cb-inbox-reply-by">
              {r.visitorName?.trim() || "anonymous"} replied
            </div>
            {r.text}
          </div>
        </div>
      ))}
      {replying ? (
        <ReplyForm
          capsuleId={capsuleId}
          pair={pair}
          onCancel={() => setReplying(false)}
          onSubmit={(entry) => {
            onReply(entry);
            setReplying(false);
          }}
        />
      ) : (
        <button className="cb-inbox-reply-btn" onClick={() => setReplying(true)}>
          + add your answer
        </button>
      )}
    </div>
  );
}

function ReplyForm({ capsuleId, pair, onCancel, onSubmit }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const visitorName = readName();

  async function submit() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/capsules/${capsuleId}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: t,
          replyToTs: pair.aTs,
          replyToSession: pair.sessionId,
          sessionId: pair.sessionId,
          visitorName,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      onSubmit(data.entry);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cb-inbox-replyform">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={visitorName ? `reply as ${visitorName}…` : "your reply…"}
        rows={3}
        disabled={busy}
      />
      {error && <div className="cb-fail-text">{error}</div>}
      <div className="cb-inbox-replyform-actions">
        <button onClick={onCancel} className="cb-inbox-cancel">cancel</button>
        <button onClick={submit} disabled={busy || !text.trim()}>
          {busy ? "sending…" : "send reply"}
        </button>
      </div>
    </div>
  );
}

function readName() {
  try { return localStorage.getItem("cb_visitor_name") || ""; } catch { return ""; }
}

// Group visits by sessionId, build (Q,A) pairs preserving ts, and attach any
// replies that point at each pair via {replyTo: {ts, sessionId}}.
function groupSessions(visits) {
  const sessionMap = new Map();
  const replies = [];
  for (const v of visits) {
    if (v.role === "reply") {
      replies.push(v);
      continue;
    }
    const id = v.sessionId || "anon";
    if (!sessionMap.has(id)) {
      sessionMap.set(id, { id, entries: [], lastTs: v.ts, visitorName: v.visitorName });
    }
    const s = sessionMap.get(id);
    s.entries.push(v);
    s.lastTs = v.ts;
    if (v.visitorName) s.visitorName = v.visitorName;
  }

  // Index replies by their target pair key
  const repliesByKey = new Map();
  for (const r of replies) {
    if (!r.replyTo) continue;
    const key = `${r.replyTo.sessionId}@${r.replyTo.ts}`;
    if (!repliesByKey.has(key)) repliesByKey.set(key, []);
    repliesByKey.get(key).push(r);
  }

  const sessions = [];
  for (const s of sessionMap.values()) {
    s.pairs = pairUp(s.entries, s.id).map((p) => ({
      ...p,
      replies: repliesByKey.get(`${s.id}@${p.aTs}`) || [],
    }));
    sessions.push(s);
  }
  return sessions.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

function pairUp(entries, sessionId) {
  const pairs = [];
  let cur = null;
  for (const e of entries) {
    if (e.role === "user") {
      if (cur) pairs.push(cur);
      cur = { question: e.text, answer: "", qTs: e.ts, aTs: null, sessionId };
    } else if (e.role === "assistant" && cur) {
      cur.answer = e.text;
      cur.aTs = e.ts;
      pairs.push(cur);
      cur = null;
    }
  }
  if (cur) pairs.push(cur);
  return pairs;
}

function relTime(iso) {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (Number.isNaN(diff)) return "";
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
