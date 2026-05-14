/**
 * Server-side in-memory store for sandboxed tool runs.
 *
 * POC NOTE: M8 locked "no app/api routes" — the production home for
 * `use_repo` is the api package (MCP tool surface). For this POC we
 * keep the run state co-located with the Next.js process so the demo
 * is self-contained and doesn't require running the full beevibe
 * api + daemon + postgres stack. Once the sandbox broker integrates
 * with the existing daemon path, this module disappears.
 *
 * The store is parked on `globalThis` so it survives Next.js dev-mode
 * HMR (which otherwise re-evaluates this module per route file and
 * gives each route its own private Map — POST writes, GET reads,
 * neither sees the other).
 */
import type { RunState } from "@beevibe/sandbox/orchestrator";

const GLOBAL_KEY = "__beevibe_tools_run_store__";

interface GlobalShape {
  [GLOBAL_KEY]?: Map<string, RunState>;
}

const g = globalThis as unknown as GlobalShape;
if (!g[GLOBAL_KEY]) {
  g[GLOBAL_KEY] = new Map<string, RunState>();
}
const STORE: Map<string, RunState> = g[GLOBAL_KEY]!;

export function upsertRun(state: RunState): void {
  STORE.set(state.run_id, state);
}

export function getRun(run_id: string): RunState | undefined {
  return STORE.get(run_id);
}

export function listRuns(): RunState[] {
  return Array.from(STORE.values()).sort((a, b) =>
    (b.started_at ?? "").localeCompare(a.started_at ?? ""),
  );
}

export function generateRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
