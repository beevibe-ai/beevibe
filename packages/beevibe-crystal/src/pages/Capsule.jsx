import { Link, useParams } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { loadCapsule, saveCapsule } from "../lib/store.js";
import VisitorChat from "../components/VisitorChat.jsx";
import MindMap from "../components/MindMap.jsx";
import BeevibeAttribution from "../components/BeevibeAttribution.jsx";

export default function CapsuleView() {
  const { id } = useParams();
  const [capsule, setCapsule] = useState(() => loadCapsule(id));
  const [status, setStatus] = useState(capsule ? "ok" : "loading");
  const [hasMessages, setHasMessages] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const chatRef = useRef(null);

  function handleSelectNode(node) {
    setSelectedNode(node);
    chatRef.current?.seedInput(`Tell me about ${node.title.toLowerCase()}.`);
  }

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
    return () => {
      cancelled = true;
    };
  }, [id, capsule]);

  if (!capsule) {
    return (
      <div className="cb-shell cb-capsule">
        <div className="cb-overlay cb-center cb-not-found">
          <h1 className="cb-headline-sm">
            {status === "loading" ? "Fetching capsule…" : "Not found."}
          </h1>
          <p className="cb-lede">
            {status === "loading" ? (
              <>looking up <code>{id}</code> on the server.</>
            ) : (
              <>Capsule <code>{id}</code> isn't on this server or in this browser.</>
            )}
          </p>
          <Link to="/" className="cb-cta cb-cta-ghost">← back</Link>
          <BeevibeAttribution compact />
        </div>
      </div>
    );
  }

  const m = capsule.metadata;

  return (
    <div className="cb-shell cb-capsule">
      <div className="cb-overlay cb-capsule-overlay">
        <header className="cb-capsule-top">
          <Link to="/" className="cb-wordmark cb-back-link">← Crystal Ball</Link>
          <Link to={`/c/${id}/inbox`} className="cb-inbox-toggle cb-inbox-toggle-header">
            Inbox
          </Link>
        </header>

        <div className="cb-capsule-split">
          <section className="cb-pane cb-pane-chat">
            <div className="cb-pane-head">
              <div className="cb-capsule-avatar cb-capsule-avatar-sm" aria-hidden />
              <div className="cb-pane-head-text">
                <h1 className="cb-capsule-lede">
                  {capsule.lede || capsule.title}
                </h1>
                {capsule.gist && <p className="cb-capsule-gist">{capsule.gist}</p>}
              </div>
            </div>

            <VisitorChat
              ref={chatRef}
              capsule={capsule}
              onActivity={(n) => setHasMessages(n > 0)}
            />
          </section>

          <section className="cb-pane cb-pane-map">
            <div className="cb-pane-head cb-pane-head-map">
              <span className="cb-pane-label">Mind Map</span>
              {selectedNode && (
                <span className="cb-pane-selected" title={selectedNode.title}>
                  · {selectedNode.title}
                </span>
              )}
            </div>
            {capsule.map?.branches?.length > 0 ? (
              <MindMap
                map={capsule.map}
                selectedId={selectedNode?.id}
                onSelectNode={handleSelectNode}
              />
            ) : (
              <div className="cb-pane-empty">No map generated for this capsule.</div>
            )}
          </section>
        </div>

        <footer className="cb-capsule-footer">
          <BeevibeAttribution />
        </footer>
      </div>
    </div>
  );
}
