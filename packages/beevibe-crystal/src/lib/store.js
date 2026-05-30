// Capsules live in localStorage for v0 — no backend persistence.
// Capsule id is part of the URL path, so links work as long as the recipient
// loads the same machine. For real sharing we'll need an actual store; this
// is intentionally a stub to keep MVP small.

const KEY = "crystal-ball:capsules";

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

function writeAll(map) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch (err) {
    // QuotaExceededError on large capsules — cache is best-effort, not required.
    console.warn("capsule cache write failed:", err?.message || err);
  }
}

export function saveCapsule(capsule) {
  const all = readAll();
  all[capsule.id] = capsule;
  writeAll(all);
}

export function loadCapsule(id) {
  return readAll()[id] || null;
}

export function listCapsules() {
  const all = readAll();
  return Object.values(all).sort((a, b) =>
    (b.publishedAt || "").localeCompare(a.publishedAt || "")
  );
}

export function deleteCapsule(id) {
  const all = readAll();
  delete all[id];
  writeAll(all);
}
