import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeRuntime } from "./runtime.js";

/**
 * End-to-end smoke test against a real `claude` CLI binary.
 *
 * Gated by RUN_CLAUDE_SMOKE=1. CI does not run this (no env var, no
 * binary). Manual invocation on a dev machine with `claude` in PATH:
 *
 *   RUN_CLAUDE_SMOKE=1 pnpm --filter @beevibe/core test smoke
 *
 * Validates the full stack: subprocess spawn, stdin piping, stream-json
 * parsing, result mapping, and MCP config path derivation.
 */
const RUN = process.env.RUN_CLAUDE_SMOKE === "1";

describe.skipIf(!RUN)("ClaudeCodeRuntime (smoke)", () => {
  let workspacePath: string;

  beforeAll(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "beevibe-smoke-"));
    writeFileSync(
      join(workspacePath, "mcp-config.json"),
      JSON.stringify({ mcpServers: {} }),
    );
  });

  afterAll(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it(
    "executes a trivial prompt against the real claude binary",
    async () => {
      const runtime = new ClaudeCodeRuntime({ maxTurns: 1 });
      const result = await runtime.execute({
        intent: "Reply with the literal word 'ok' and nothing else.",
        workspace: { path: workspacePath },
        system_prompt_append: "",
      });

      expect(result.status).toBe("completed");
      expect(result.output.toLowerCase()).toContain("ok");
      expect(result.cli_session_id).toBeDefined();
      expect(result.process_pid).toBeGreaterThan(0);
    },
    60_000, // real claude session can take a while
  );

  it("healthCheck returns healthy against a real binary", async () => {
    const runtime = new ClaudeCodeRuntime();
    const health = await runtime.healthCheck();
    expect(health.healthy).toBe(true);
  });
});
