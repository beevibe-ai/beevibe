#!/usr/bin/env node
/**
 * Real end-to-end demo: a child claude session, inside a sandbox,
 * uses pdfplumber to extract tables from a sample PDF. No
 * deterministic install commands — the agent figures it out.
 *
 * Run: pnpm --filter @beevibe/sandbox exec tsx src/scripts/orchestrate-pdfplumber.ts
 */
import { runRepoAgent } from "../orchestrator.js";

const CLAUDE_BIN = process.env.BEEVIBE_CLAUDE_BIN ?? "claude";

async function main(): Promise<void> {
  const state = await runRepoAgent({
    run_id: `demo-${Date.now()}`,
    repo_url: "https://github.com/jsvine/pdfplumber",
    goal:
      "Extract the tables from the bundled sample PDF " +
      "(tests/pdfs/federal-register-2020-17221.pdf in the repo) into " +
      "structured JSON. Export the JSON as the artifact for the user.",
    claude_bin: CLAUDE_BIN,
    max_budget_usd: 3,
    max_runtime_seconds: 600,
    on_state: (s) => {
      // Print a single-line marker each time state advances.
      const last = s.transcript[s.transcript.length - 1];
      if (!last) return;
      const head = last.text.split("\n")[0]?.slice(0, 140) ?? "";
      process.stdout.write(`[${s.status}] ${last.kind}: ${head}\n`);
    },
  });

  process.stdout.write(`\n=== FINAL ===\nstatus: ${state.status}\n`);
  if (state.error) process.stdout.write(`error: ${state.error}\n`);
  process.stdout.write(`artifacts (${state.artifacts.length}):\n`);
  for (const a of state.artifacts) {
    process.stdout.write(
      `  - ${a.title} (${a.size_bytes} bytes) → ${a.host_path}\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(`[orchestrate] FAILED: ${err.message ?? err}\n`);
  process.exit(1);
});
