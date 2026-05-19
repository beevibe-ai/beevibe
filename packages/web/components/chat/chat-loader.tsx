/**
 * Honeycomb loader shown in the agent reply column before the first
 * streamed text or tool step lands. 37 hex cells in 4 concentric rings
 * pulse-scale on staggered delays so the comb breathes outward — a
 * single deliberate "agent is starting" moment in place of three-dot
 * flicker. Styles live in globals.css under `.bv-chat-loader` because
 * the cell positions use 37 individual `:nth-child`-style class hooks
 * (Tailwind can't express that compactly).
 *
 * Bricks pull their color from `--foreground`, so the loader reads
 * correctly on both cream (light) and near-black (dark) backgrounds.
 */
const RING_1_CELLS = [1, 2, 3, 4, 5, 6];
const RING_2_CELLS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
// Original Uiverse markup skips c27 — the outermost ring has 18 cells
// numbered c19..c26 + c28..c37. Keeping the gap preserves the exact
// positioning of every other cell.
const RING_3_CELLS = [
  19, 20, 21, 22, 23, 24, 25, 26, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37,
];

function Cell({ className }: { className: string }) {
  return (
    <div className={`gel ${className}`}>
      <div className="hex-brick h1" />
      <div className="hex-brick h2" />
      <div className="hex-brick h3" />
    </div>
  );
}

export function ChatLoader() {
  return (
    <div
      className="bv-chat-loader"
      role="status"
      aria-label="Agent is thinking"
    >
      <div className="bv-chat-loader-inner">
        <Cell className="center-gel" />
        {RING_1_CELLS.map((c) => (
          <Cell key={c} className={`c${c} r1`} />
        ))}
        {RING_2_CELLS.map((c) => (
          <Cell key={c} className={`c${c} r2`} />
        ))}
        {RING_3_CELLS.map((c) => (
          <Cell key={c} className={`c${c} r3`} />
        ))}
      </div>
    </div>
  );
}
