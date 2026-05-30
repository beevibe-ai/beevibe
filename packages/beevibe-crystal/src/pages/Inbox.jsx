import { Link, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { loadCapsule, saveCapsule } from "../lib/store.js";
import VisitInbox from "../components/VisitInbox.jsx";

export default function InboxPage() {
  const { id } = useParams();
  const [capsule, setCapsule] = useState(() => loadCapsule(id));
  const [status, setStatus] = useState(capsule ? "ok" : "loading");

  useEffect(() => {
    if (capsule) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/capsules/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        saveCapsule(data);
        setCapsule(data);
        setStatus("ok");
      } catch {
        if (!cancelled) setStatus("missing");
      }
    })();
    return () => { cancelled = true; };
  }, [id, capsule]);

  return (
    <div className="cb-shell cb-inbox-page">
      <header className="cb-capsule-top">
        <Link to={`/c/${id}`} className="cb-wordmark cb-back-link">
          ← Back to capsule
        </Link>
        <div className="cb-pane-label">Inbox</div>
      </header>
      <div className="cb-inbox-page-body">
        <div className="cb-inbox-page-inner">
          <h1 className="cb-inbox-page-title">
            {capsule?.lede || capsule?.title || "Inbox"}
          </h1>
          <p className="cb-inbox-page-sub">
            Questions visitors asked this capsule. Click a Q/A pair to add
            your own answer — future visitors will see it.
          </p>
          {status === "loading" && (
            <div className="cb-dim cb-inbox-empty">loading…</div>
          )}
          {status === "missing" && (
            <div className="cb-fail-text">Capsule not found.</div>
          )}
          {capsule && <VisitInbox capsuleId={id} open={true} />}
        </div>
      </div>
    </div>
  );
}
