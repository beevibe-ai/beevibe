// Map a capsule's metadata to visual parameters for the 3D crystal.
// Kept pure & deterministic so the same capsule always renders the same crystal.

const TOPIC_HUE = {
  debug: 0.02,     // red-orange
  refactor: 0.55,  // cyan
  design: 0.7,     // violet
  infra: 0.35,     // green
  test: 0.15,      // amber
  data: 0.6,       // blue
  ui: 0.85,        // pink
};

export function crystalParams(capsule) {
  const m = capsule.metadata || {};
  const size = clamp(0.6 + Math.log1p(m.messageCount || 1) * 0.18, 0.7, 1.6);
  const hue = dominantHue(m.topics);
  const roughness = clamp(0.05 + (m.toolCallCount || 0) / 80, 0.05, 0.45);
  // "cracks" — visual representation of abandoned approaches.
  const cracks = clamp(m.abandonedCount || 0, 0, 8);
  // Glow if resolved.
  const emissive = m.outcome === "resolved" ? 0.35 : m.outcome === "abandoned" ? 0.05 : 0.18;
  // A second tint, hashed from id, so two same-topic capsules don't look identical.
  const accent = hashHue(capsule.id || capsule.title || "");
  return { size, hue, accent, roughness, cracks, emissive };
}

function dominantHue(topics = []) {
  if (!topics.length) return 0.62;
  for (const t of topics) if (TOPIC_HUE[t] != null) return TOPIC_HUE[t];
  return 0.62;
}

function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return ((h & 0xff) / 255 + 0.5) % 1;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
