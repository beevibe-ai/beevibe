import { useCallback, useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { parseFile } from "../lib/parser.js";
import { saveCapsule, listCapsules } from "../lib/store.js";
import { CrystalStage, CrystalInline } from "../components/CrystalCover.jsx";
import BeevibeAttribution from "../components/BeevibeAttribution.jsx";

export default function Upload() {
  const navigate = useNavigate();
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    setRecent(listCapsules().slice(0, 4));
  }, []);

  async function publish(capsule) {
    // Try the server first so we save the canonical (server-id'd) capsule.
    // If the server is down, fall back to the client's seed id — capsule
    // still works locally and the share link will just 404 elsewhere.
    let canonical = capsule;
    try {
      const res = await fetch("/api/capsules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capsule }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.capsule) canonical = data.capsule;
      }
    } catch {
      // server unreachable — keep client capsule
    }
    saveCapsule(canonical);
    return canonical;
  }

  const handleFiles = useCallback(
    async (files) => {
      setError("");
      const file = files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const { capsule, warnings } = parseFile(text, file.name);
        if (warnings.length) console.warn("[capsule warnings]", warnings);
        const published = await publish(capsule);
        navigate(`/c/${published.id}`);
      } catch (e) {
        setError(e.message || String(e));
      }
    },
    [navigate]
  );

  async function loadSample() {
    setError("");
    try {
      const res = await fetch("./examples/sample-session.jsonl");
      const text = await res.text();
      const { capsule } = parseFile(text, "sample-session.jsonl");
      capsule.title = "Debugging a payment retry double-charge";
      const published = await publish(capsule);
      navigate(`/c/${published.id}`);
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  // Page-wide drag handling — the whole page is the dropzone.
  useEffect(() => {
    const onOver = (e) => {
      e.preventDefault();
      setDragOver(true);
    };
    const onLeave = (e) => {
      if (e.target === document.documentElement) setDragOver(false);
    };
    const onDrop = (e) => {
      e.preventDefault();
      setDragOver(false);
      handleFiles(e.dataTransfer.files);
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [handleFiles]);

  return (
    <div className={`cb-shell cb-upload ${dragOver ? "cb-shell-drag" : ""}`}>
      <CrystalStage pulse={dragOver} intensity={dragOver ? 1.6 : 1} />

      <div className="cb-overlay cb-upload-overlay">
        <div className="cb-wordmark">crystal ball</div>

        <div className="cb-center">
          <h1 className="cb-headline">The thinking,<br/>not the transcript.</h1>
          <p className="cb-lede">
            Drop a Claude Code session. Get a capsule others can ask —
            it answers in your voice, with the full context behind it.
          </p>

          <div className="cb-actions">
            <label className="cb-cta">
              <input
                type="file"
                accept=".jsonl,.json"
                onChange={(e) => handleFiles(e.target.files)}
                hidden
              />
              Drop a session
            </label>
            <button className="cb-cta cb-cta-ghost" onClick={loadSample}>
              or try the sample →
            </button>
          </div>

          {error && <div className="cb-error">{error}</div>}
        </div>

        {dragOver && (
          <div className="cb-drag-hint">release to crystallize</div>
        )}

        {recent.length > 0 && (
          <div className="cb-recent-row">
            <div className="cb-recent-label">recent</div>
            <div className="cb-recent-grid">
              {recent.map((c) => (
                <Link key={c.id} to={`/c/${c.id}`} className="cb-recent-card">
                  <div className="cb-recent-thumb">
                    <CrystalInline capsule={c} height={56} />
                  </div>
                  <div className="cb-recent-body">
                    <div className="cb-recent-title">{c.title || c.id}</div>
                    <div className="cb-recent-meta">
                      <span>{c.metadata?.messageCount ?? 0} msgs</span>
                      <span aria-hidden>·</span>
                      <span>{c.metadata?.toolCallCount ?? 0} tools</span>
                      <span aria-hidden>·</span>
                      <span className={`cb-outcome cb-outcome-${c.metadata?.outcome || "unknown"}`}>
                        {c.metadata?.outcome || "unknown"}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        <BeevibeAttribution />
      </div>
    </div>
  );
}
