#!/usr/bin/env node
/**
 * Verifies that env vars set on the `claude` CLI process propagate to stdio
 * MCP server subprocesses spawned by the CLI.
 *
 * If this works, we can use `BEEVIBE_SESSION_ID` on the CLI env (set per
 * invocation by ClaudeCodeRuntime) as the session-id carrier — no mcp-config
 * rewrites, no per-session config files, no prompt injection.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ws = mkdtempSync(join(tmpdir(), "beevibe-env-test-"));

// 1. Stub MCP server — dumps its env to a file on startup, then stays alive
//    briefly so the `claude` handshake doesn't blow up.
const stubPath = join(ws, "stub-mcp.mjs");
const dumpPath = join(ws, "env-dump.json");
writeFileSync(
  stubPath,
  `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({
  BEEVIBE_SESSION_ID: process.env.BEEVIBE_SESSION_ID ?? null,
  BEEVIBE_AGENT_ID:   process.env.BEEVIBE_AGENT_ID   ?? null,
  PATH_preserved:     Boolean(process.env.PATH),
  pid:                process.pid,
  ppid:               process.ppid,
}, null, 2));
// Stay alive briefly so 'claude' doesn't panic over the connection vanishing.
// We don't actually speak MCP — the env dump is the whole test.
setTimeout(() => process.exit(0), 5000);
`,
);

// 2. MCP config referencing the stub. NOTE: no explicit "env" field here,
//    so the stub inherits whatever env claude hands it.
writeFileSync(
  join(ws, "mcp-config.json"),
  JSON.stringify({
    mcpServers: {
      stub: {
        command: process.execPath, // node
        args: [stubPath],
      },
    },
  }),
);

// 3. Spawn `claude` with test env vars set.
const TEST_SESSION = `sess_probe_${Date.now()}`;
const TEST_AGENT = `agent_probe_${Date.now()}`;

console.log(`Test env:
  BEEVIBE_SESSION_ID=${TEST_SESSION}
  BEEVIBE_AGENT_ID=${TEST_AGENT}
workspace: ${ws}
`);

const childEnv = { ...process.env };
// Strip Claude nesting guards (matches ClaudeCodeRuntime).
delete childEnv.CLAUDECODE;
delete childEnv.CLAUDE_CODE_ENTRYPOINT;
delete childEnv.CLAUDE_CODE_SESSION;
delete childEnv.CLAUDE_CODE_PARENT_SESSION;
childEnv.BEEVIBE_SESSION_ID = TEST_SESSION;
childEnv.BEEVIBE_AGENT_ID = TEST_AGENT;

const child = spawn(
  "claude",
  [
    "--print",
    "-",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--strict-mcp-config",
    "--mcp-config",
    join(ws, "mcp-config.json"),
    "--append-system-prompt",
    "",
    "--max-turns",
    "1",
  ],
  {
    cwd: ws,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  },
);

child.stdin.write("say 'ok' and nothing else.");
child.stdin.end();

let stderrBuf = "";
child.stdout.on("data", () => {
  /* swallow */
});
child.stderr.on("data", (chunk) => {
  stderrBuf += chunk.toString();
});

await new Promise((resolve) => child.on("exit", resolve));

// 4. Inspect the dump.
if (!existsSync(dumpPath)) {
  console.error("✗ Stub MCP server never wrote its env dump.");
  console.error("  Claude CLI may not have spawned it. stderr tail:");
  console.error(stderrBuf.slice(-2000));
  process.exit(1);
}

const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
console.log("\n=== MCP server (stub subprocess) saw env ===");
console.log(JSON.stringify(dump, null, 2));
console.log("\n=== Expected ===");
console.log(`  BEEVIBE_SESSION_ID: ${TEST_SESSION}`);
console.log(`  BEEVIBE_AGENT_ID:   ${TEST_AGENT}`);

const sessionOk = dump.BEEVIBE_SESSION_ID === TEST_SESSION;
const agentOk = dump.BEEVIBE_AGENT_ID === TEST_AGENT;

if (sessionOk && agentOk) {
  console.log(
    "\n✓ Env vars propagated from `claude` CLI → stdio MCP server subprocess.",
  );
  process.exit(0);
} else {
  console.error("\n✗ Env vars did NOT propagate.");
  console.error(`  session matched: ${sessionOk}, agent matched: ${agentOk}`);
  process.exit(1);
}
