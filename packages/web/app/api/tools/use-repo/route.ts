/**
 * POC: kick off a sandboxed tool run.
 *
 * POST { repo_url, goal, input_url?, input_filename? } → 202 + { run_id }
 *
 * The orchestrator runs async in the same Next.js server process; clients
 * poll `/api/tools/runs/[run_id]` for status + artifacts. State lives
 * in-memory in `@/lib/tools/run-store`.
 *
 * Lives under `app/api/*` for the POC only (M8 normally forbids it).
 * See `lib/tools/run-store.ts` for the deviation rationale.
 */
import { NextResponse } from "next/server";
import { runRepoAgent } from "@beevibe/sandbox/orchestrator";
import { generateRunId, upsertRun } from "@/lib/tools/run-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Default to a VS Code extension copy of the claude binary. Override via
// BEEVIBE_CLAUDE_BIN. Falls back to whatever `claude` resolves to via PATH.
const DEFAULT_CLAUDE_BIN =
  "/Users/weijiasong/.vscode/extensions/anthropic.claude-code-2.1.140-darwin-arm64/resources/native-binary/claude";

interface Body {
  repo_url?: unknown;
  goal?: unknown;
  input_url?: unknown;
  input_filename?: unknown;
  max_runtime_seconds?: unknown;
  max_budget_usd?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const repo_url = typeof body.repo_url === "string" ? body.repo_url.trim() : "";
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!repo_url || !goal) {
    return NextResponse.json(
      { error: "missing_fields", message: "repo_url and goal are required" },
      { status: 400 },
    );
  }

  const input_url =
    typeof body.input_url === "string" && body.input_url.trim().length > 0
      ? body.input_url.trim()
      : undefined;
  const input_filename =
    typeof body.input_filename === "string" && body.input_filename.trim().length > 0
      ? body.input_filename.trim()
      : undefined;
  const max_runtime_seconds =
    typeof body.max_runtime_seconds === "number" ? body.max_runtime_seconds : 600;
  const max_budget_usd =
    typeof body.max_budget_usd === "number" ? body.max_budget_usd : 3;

  const run_id = generateRunId();

  // Kick off the orchestrator async. Persist state on every update.
  upsertRun({
    run_id,
    status: "starting",
    repo_url,
    goal,
    started_at: new Date().toISOString(),
    transcript: [],
    artifacts: [],
  });

  void runRepoAgent({
    run_id,
    repo_url,
    goal,
    input_url,
    input_filename,
    claude_bin: process.env.BEEVIBE_CLAUDE_BIN ?? DEFAULT_CLAUDE_BIN,
    max_runtime_seconds,
    max_budget_usd,
    on_state: (s) => upsertRun(s),
  }).then(
    (final) => upsertRun(final),
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      upsertRun({
        run_id,
        status: "failed",
        repo_url,
        goal,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        transcript: [],
        artifacts: [],
        error: msg,
      });
    },
  );

  return NextResponse.json({ run_id }, { status: 202 });
}
