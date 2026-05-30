export const CAPSULE_VERSION = "0.1.0";

// Capsule ids are user-visible in URLs and used as filesystem-path components
// on the server. This regex is the contract.
export const ID_RE = /^[a-z0-9]{4,32}$/i;

export function emptyCapsule() {
  return {
    version: CAPSULE_VERSION,
    id: "",
    source: "claude-code",
    publishedAt: new Date().toISOString(),
    title: "",
    summary: "",
    metadata: {
      model: "",
      durationMs: 0,
      messageCount: 0,
      toolCallCount: 0,
      fileChangeCount: 0,
      abandonedCount: 0,
      outcome: "in-progress",
      topics: [],
    },
    events: [],
    context: { files: [], repo: "", branch: "" },
    visibility: "unlisted",
  };
}

export function isCapsule(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.version !== "string") return false;
  if (!Array.isArray(value.events)) return false;
  if (value.id != null && (typeof value.id !== "string" || !ID_RE.test(value.id))) return false;
  if (value.metadata != null && typeof value.metadata !== "object") return false;
  return true;
}

// Shared content-block text extraction. Used by parser, server, and viewer —
// each previously had its own copy with the same logic.
export function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text")
    .map((b) => b.text || "")
    .join("\n");
}
