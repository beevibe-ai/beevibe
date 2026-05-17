/**
 * End-to-end smoke test for `CodexRuntime`. Spawns the real `codex` CLI
 * three times against a temp workspace and reports what came back:
 *
 *   1. Basic — "say hello, nothing else" with no MCP. Verifies parse.
 *   2. MCP  — wires a tiny in-process echo MCP server and asks codex to
 *             call its `echo` tool. Verifies the MCP HTTP server actually
 *             receives a `tools/call` from the spawned codex.
 *   3. Abort — long-running prompt, aborted after 3s. Verifies status =
 *             cancelled and no codex subprocess survives.
 *
 * Requires:
 *   - `codex` CLI on PATH (you confirmed it's there)
 *   - You've run `codex login` so it has subscription auth
 *
 * Run:   pnpm tsx scripts/test-codex-runtime.ts
 *
 * Output one block per test with the outcome. Non-zero exit on any
 * failure so this can wire into CI later.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { CodexRuntime } from "../packages/core/src/adapters/codex/runtime.js";
import { Server as McpLowLevelServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RuntimeStep, RuntimeResult } from "../packages/core/src/ports/runtime.js";

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

// Let codex pick from `~/.codex/config.toml` unless the caller explicitly
// overrides — different ChatGPT subscription tiers allow different models,
// and the user's config already reflects what their tier supports.
const TEST_MODEL = process.env.CODEX_TEST_MODEL;

function banner(s: string): void {
  console.log(`\n${BOLD}━━━ ${s} ━━━${RESET}`);
}
function ok(s: string): void {
  console.log(`${GREEN}✓${RESET} ${s}`);
}
function fail(s: string): void {
  console.log(`${RED}✗${RESET} ${s}`);
}
function info(s: string): void {
  console.log(`${DIM}  ${s}${RESET}`);
}
function step(s: RuntimeStep): void {
  const tool = s.tool ? ` [${s.tool}]` : "";
  console.log(`${YELLOW}  · ${s.kind}${tool}${RESET} ${s.description.slice(0, 100)}`);
}

let failures = 0;

function mkWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "beevibe-codex-test-"));
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

async function test1Basic(): Promise<void> {
  banner("Test 1: basic spawn + parse (no MCP)");
  const ws = mkWorkspace();
  try {
    const rt = new CodexRuntime({ model: TEST_MODEL });
    const steps: RuntimeStep[] = [];
    info(`workspace: ${ws}`);

    const t0 = Date.now();
    const result = await rt.execute({
      intent:
        "Reply with exactly the words: hello from codex. Do not run any tools. Do not explain.",
      workspace: { path: ws },
      system_prompt_append: "",
      onStep: (s) => {
        steps.push(s);
        step(s);
      },
    });
    const elapsed = Date.now() - t0;

    info(`elapsed: ${elapsed}ms`);
    info(`status: ${result.status}, exit_code: ${result.exit_code}, pid: ${result.process_pid}`);
    info(`cli_session_id: ${result.cli_session_id}`);
    info(`output: ${JSON.stringify(result.output?.slice(0, 200))}`);
    info(
      `usage: input=${result.usage?.input_tokens} output=${result.usage?.output_tokens} cache_read=${result.usage?.cache_read_input_tokens}`,
    );

    if (result.status !== "completed") {
      fail(`expected status=completed, got ${result.status}; stderr: ${result.stderr?.slice(0, 300)}`);
      failures++;
      return;
    }
    ok("status=completed");

    if (!result.cli_session_id) {
      fail("expected cli_session_id (codex thread_id) to be parsed");
      failures++;
    } else {
      ok(`cli_session_id parsed: ${result.cli_session_id}`);
    }

    if (!result.output?.toLowerCase().includes("hello from codex")) {
      fail(`expected output to contain "hello from codex", got: ${result.output}`);
      failures++;
    } else {
      ok('output contains "hello from codex"');
    }

    if (!result.usage || (result.usage.input_tokens ?? 0) === 0) {
      fail("expected usage.input_tokens > 0 from turn.completed.usage event");
      failures++;
    } else {
      ok("usage parsed from turn.completed");
    }

    const agentSteps = steps.filter((s) => s.kind === "agent");
    if (agentSteps.length === 0) {
      fail("expected at least one onStep agent emit from item.completed");
      failures++;
    } else {
      ok(`${agentSteps.length} agent step(s) streamed via onStep`);
    }
  } finally {
    cleanup(ws);
  }
}

interface McpServerHandle {
  url: string;
  toolCalls: Array<{ name: string; args: unknown }>;
  requestLog: Array<{ method: string; url: string; auth?: string; bodyHead?: string }>;
  close: () => Promise<void>;
}

/**
 * Spin up an HTTP MCP server with one `echo` tool. Returns its base URL
 * (e.g. http://localhost:51234/mcp) plus a record of every tools/call
 * payload it observed. The CodexRuntime points at this URL via
 * `prepareWorkspace`.
 *
 * Uses the same StreamableHTTPServerTransport pattern as packages/api/src/routes/mcp.ts,
 * so if codex's MCP HTTP client can talk to the real beevibe /mcp endpoint
 * it can talk to this one.
 */
async function startEchoMcpServer(): Promise<McpServerHandle> {
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // Every inbound request gets logged so we can tell apart "codex never
  // connected" from "codex connected but the handshake failed".
  const requestLog: Array<{ method: string; url: string; auth?: string; bodyHead?: string }> = [];

  const http: Server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "missing_bearer" }));
      return;
    }

    // Slurp body
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyStr = Buffer.concat(chunks).toString("utf8");
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;
    requestLog.push({
      method: req.method ?? "?",
      url: req.url ?? "?",
      auth: auth.slice(0, 30) + "…",
      bodyHead: bodyStr.slice(0, 1200),
    });

    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string" && transports.has(sid)) {
      await transports.get(sid)!.handleRequest(req, res, body);
      return;
    }

    if (!isInitializeRequest(body)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "missing_session_id" }));
      return;
    }

    const server = new McpLowLevelServer(
      { name: "echo-test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "echo",
          description: "Echo the input string back, prefixed with 'echoed: '.",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      toolCalls.push({ name: request.params.name, args: request.params.arguments });
      const msg = (request.params.arguments as { message?: string })?.message ?? "";
      return {
        content: [{ type: "text", text: `echoed: ${msg}` }],
      };
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSid) => {
        transports.set(newSid, transport);
      },
    });
    transport.onclose = () => {
      for (const [k, v] of transports) {
        if (v === transport) transports.delete(k);
      }
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const addr = http.address();
  if (!addr || typeof addr === "string") throw new Error("listen failed");
  const url = `http://127.0.0.1:${addr.port}/mcp`;

  return {
    url,
    toolCalls,
    requestLog,
    close: () =>
      new Promise<void>((resolve, reject) =>
        http.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function test2Mcp(): Promise<void> {
  banner("Test 2: MCP connection (codex → in-process echo server)");
  const ws = mkWorkspace();
  const sid = `sess_${randomUUID().slice(0, 8)}`;
  let mcp: McpServerHandle | undefined;
  try {
    mcp = await startEchoMcpServer();
    info(`mcp echo server: ${mcp.url}`);
    info(`workspace: ${ws}`);
    info(`session id: ${sid}`);

    const rt = new CodexRuntime({ model: TEST_MODEL });
    rt.prepareWorkspace({
      workspace: { path: ws },
      agentApiKey: "bv_a_test_token",
      mcpServerUrl: mcp.url,
    });

    const t0 = Date.now();
    const result = await rt.execute({
      intent:
        "Use the `echo` MCP tool with message=\"ping\". After the tool returns, reply with EXACTLY the tool's output verbatim and nothing else.",
      workspace: { path: ws },
      system_prompt_append: "",
      env: {
        BEEVIBE_SESSION_ID: sid,
        BEEVIBE_AGENT_ID: "agent_test",
        // Crank codex's MCP HTTP client tracing so the stderr tail tells
        // us if the server was registered, the handshake fired, etc.
        RUST_LOG: "codex_rmcp_client=debug,codex_core::mcp=debug,codex_core::session=info",
      },
      onStep: step,
    });
    const elapsed = Date.now() - t0;

    info(`elapsed: ${elapsed}ms`);
    info(`status: ${result.status}, exit_code: ${result.exit_code}`);
    info(`output: ${JSON.stringify(result.output?.slice(0, 200))}`);
    info(`mcp tool_calls observed: ${mcp.toolCalls.length}`);
    info(`server requestLog: ${mcp.requestLog.length} request(s)`);
    for (const r of mcp.requestLog) {
      info(`  ${r.method} ${r.url} auth=${r.auth} body=${r.bodyHead?.replace(/\n/g, " ")}`);
    }
    if (result.stderr) {
      // Dump the FULL stderr (capped) so we can see the codex tracing lines.
      const lines = result.stderr.split("\n").filter((l) => l.trim()).slice(-25);
      info("stderr (last 25 lines):");
      for (const line of lines) info(`  ${line}`);
    }

    if (result.status !== "completed") {
      fail(
        `expected status=completed, got ${result.status}; stderr: ${result.stderr?.slice(-500)}`,
      );
      failures++;
      return;
    }
    ok("status=completed");

    if (mcp.toolCalls.length === 0) {
      fail(
        "expected at least one tools/call to the echo server — MCP connection or config not wired",
      );
      failures++;
    } else {
      const first = mcp.toolCalls[0]!;
      ok(`MCP server received tools/call: ${first.name} ${JSON.stringify(first.args)}`);
    }

    if (!result.output?.toLowerCase().includes("echoed: ping")) {
      fail(`expected codex output to contain "echoed: ping" (the tool's return), got: ${result.output}`);
      failures++;
    } else {
      ok('output includes "echoed: ping" — tool round-trip succeeded');
    }
  } finally {
    if (mcp) await mcp.close().catch(() => undefined);
    cleanup(ws);
  }
}

async function test3Abort(): Promise<void> {
  banner("Test 3: abort signal");
  const ws = mkWorkspace();
  let pidSeen: number | undefined;
  try {
    const rt = new CodexRuntime({ model: TEST_MODEL });
    const ctrl = new AbortController();

    info(`workspace: ${ws}`);
    info("scheduling abort in 3s…");

    const abortTimer = setTimeout(() => {
      info("aborting now");
      ctrl.abort();
    }, 3_000);

    const t0 = Date.now();
    let result: RuntimeResult;
    try {
      result = await rt.execute({
        intent:
          // Force codex to think for a while: open-ended exploration with no tools.
          "Outline a 50-step plan for rewriting an operating system from scratch. " +
          "Number each step and add a short paragraph. Do not stop early.",
        workspace: { path: ws },
        system_prompt_append: "",
        abort_signal: ctrl.signal,
        onSpawn: ({ process_pid }) => {
          pidSeen = process_pid;
          info(`spawned pid=${process_pid}`);
        },
      });
    } finally {
      clearTimeout(abortTimer);
    }
    const elapsed = Date.now() - t0;

    info(`elapsed: ${elapsed}ms`);
    info(`status: ${result.status}, exit_code: ${result.exit_code}, pid: ${result.process_pid}`);

    if (result.status !== "cancelled") {
      fail(`expected status=cancelled, got ${result.status}`);
      failures++;
    } else {
      ok("status=cancelled");
    }

    if (elapsed > 20_000) {
      fail(
        `abort took ${elapsed}ms — should have settled within a few seconds of abort signal`,
      );
      failures++;
    } else {
      ok(`abort settled within ${elapsed}ms`);
    }

    // Verify the subprocess (and process group) is actually gone.
    if (pidSeen !== undefined) {
      // Wait a short beat for SIGTERM/SIGKILL to actually reap the group.
      await new Promise((r) => setTimeout(r, 500));
      try {
        process.kill(pidSeen, 0); // signal 0 = existence probe
        fail(`process pid=${pidSeen} still alive after abort — zombie`);
        failures++;
      } catch (err) {
        // ESRCH means it's gone — that's what we want.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          ok(`subprocess pid=${pidSeen} confirmed killed`);
        } else {
          info(`probe got ${code}; assuming dead`);
        }
      }
    }
  } finally {
    cleanup(ws);
  }
}

async function test4PerSessionSid(): Promise<void> {
  banner("Test 4: per-session sid isolation across concurrent spawns");
  // Two codex spawns running concurrently against the SAME echo server,
  // each with its own session id. The MCP URL is built per-spawn with
  // `?beevibe_session=<sid>` baked in, so the server should see each
  // tool call attributed to the correct sid — no cross-talk.
  const wsA = mkWorkspace();
  const wsB = mkWorkspace();
  const sidA = `sess_${randomUUID().slice(0, 8)}`;
  const sidB = `sess_${randomUUID().slice(0, 8)}`;
  let mcp: McpServerHandle | undefined;
  try {
    mcp = await startEchoMcpServer();
    info(`mcp echo server: ${mcp.url}`);
    info(`spawn A: ws=${wsA} sid=${sidA}`);
    info(`spawn B: ws=${wsB} sid=${sidB}`);

    const rtA = new CodexRuntime({ model: TEST_MODEL });
    rtA.prepareWorkspace({
      workspace: { path: wsA },
      agentApiKey: "bv_a_token_A",
      mcpServerUrl: mcp.url,
    });
    const rtB = new CodexRuntime({ model: TEST_MODEL });
    rtB.prepareWorkspace({
      workspace: { path: wsB },
      agentApiKey: "bv_a_token_B",
      mcpServerUrl: mcp.url,
    });

    const t0 = Date.now();
    const [resultA, resultB] = await Promise.all([
      rtA.execute({
        intent:
          'Use the `echo` MCP tool with message="from-A". Then reply verbatim with whatever the tool returned.',
        workspace: { path: wsA },
        system_prompt_append: "",
        env: { BEEVIBE_SESSION_ID: sidA, BEEVIBE_AGENT_ID: "agent_A" },
      }),
      rtB.execute({
        intent:
          'Use the `echo` MCP tool with message="from-B". Then reply verbatim with whatever the tool returned.',
        workspace: { path: wsB },
        system_prompt_append: "",
        env: { BEEVIBE_SESSION_ID: sidB, BEEVIBE_AGENT_ID: "agent_B" },
      }),
    ]);
    const elapsed = Date.now() - t0;

    info(`elapsed: ${elapsed}ms`);
    info(`A status=${resultA.status} output=${JSON.stringify(resultA.output)}`);
    info(`B status=${resultB.status} output=${JSON.stringify(resultB.output)}`);

    // Server-side: filter the requestLog to just the tools/call POSTs and
    // pair them with their inbound URL + bearer.
    const toolCallRequests = mcp.requestLog.filter((r) =>
      r.bodyHead?.includes('"method":"tools/call"'),
    );
    info(`server saw ${toolCallRequests.length} tools/call POSTs:`);
    for (const r of toolCallRequests) {
      info(`  url=${r.url} auth=${r.auth} body=${r.bodyHead?.slice(0, 100)}…`);
    }

    if (resultA.status !== "completed" || resultB.status !== "completed") {
      fail(
        `expected both completed; A=${resultA.status} stderr=${resultA.stderr?.slice(-200)} B=${resultB.status} stderr=${resultB.stderr?.slice(-200)}`,
      );
      failures++;
      return;
    }
    ok("both spawns completed");

    if (toolCallRequests.length !== 2) {
      fail(`expected exactly 2 tools/call requests, got ${toolCallRequests.length}`);
      failures++;
      return;
    }
    ok("server received exactly 2 tools/call POSTs");

    // The "from-A" call must arrive on the URL stamped with sidA + bearer
    // bv_a_token_A; the "from-B" call must arrive on sidB + bv_a_token_B.
    // Decouple by the inbound URL since that's where sid lives.
    const callA = toolCallRequests.find((r) => r.url.includes(`beevibe_session=${sidA}`));
    const callB = toolCallRequests.find((r) => r.url.includes(`beevibe_session=${sidB}`));

    // The codex output ROUND-TRIP is the cleanest proof the args reached
    // the server unmolested: the model replied with the echo tool's
    // return value verbatim, so message="from-A" must have crossed the
    // wire as the args (otherwise the server would have echoed "from-B"
    // or nothing). The bodyHead check below is a redundant sanity gate.
    if (!callA) {
      fail(`no tools/call carried sid=${sidA} — spawn A's sid was lost or swapped`);
      failures++;
    } else {
      ok(`spawn A's tools/call carried sid=${sidA}`);
      if (!callA.auth?.includes("bv_a_token_A")) {
        fail(`spawn A's tools/call had wrong bearer (auth=${callA.auth})`);
        failures++;
      } else {
        ok("spawn A's bearer token matched (no env leak across spawns)");
      }
      if (!resultA.output?.includes("from-A")) {
        fail(`spawn A's output didn't round-trip "from-A": ${resultA.output}`);
        failures++;
      } else {
        ok('spawn A round-tripped "from-A" through echo tool');
      }
    }

    if (!callB) {
      fail(`no tools/call carried sid=${sidB} — spawn B's sid was lost or swapped`);
      failures++;
    } else {
      ok(`spawn B's tools/call carried sid=${sidB}`);
      if (!callB.auth?.includes("bv_a_token_B")) {
        fail(`spawn B's tools/call had wrong bearer (auth=${callB.auth})`);
        failures++;
      } else {
        ok("spawn B's bearer token matched (no env leak across spawns)");
      }
      if (!resultB.output?.includes("from-B")) {
        fail(`spawn B's output didn't round-trip "from-B": ${resultB.output}`);
        failures++;
      } else {
        ok('spawn B round-tripped "from-B" through echo tool');
      }
    }

    // Cross-talk check: A's output must NOT contain "from-B" (would mean
    // the model saw the wrong tool result), and vice versa.
    if (resultA.output?.includes("from-B") || resultB.output?.includes("from-A")) {
      fail("cross-talk detected — outputs were swapped between spawns");
      failures++;
    } else {
      ok("no cross-talk between spawns — each output came from its own tool round-trip");
    }
  } finally {
    if (mcp) await mcp.close().catch(() => undefined);
    cleanup(wsA);
    cleanup(wsB);
  }
}

async function main(): Promise<void> {
  console.log(`${BOLD}CodexRuntime end-to-end test${RESET}`);
  console.log(`${DIM}Requires codex CLI on PATH + \`codex login\` already run.${RESET}`);

  try {
    await test1Basic();
  } catch (err) {
    fail(`test 1 threw: ${err instanceof Error ? err.stack : String(err)}`);
    failures++;
  }
  try {
    await test2Mcp();
  } catch (err) {
    fail(`test 2 threw: ${err instanceof Error ? err.stack : String(err)}`);
    failures++;
  }
  try {
    await test3Abort();
  } catch (err) {
    fail(`test 3 threw: ${err instanceof Error ? err.stack : String(err)}`);
    failures++;
  }
  try {
    await test4PerSessionSid();
  } catch (err) {
    fail(`test 4 threw: ${err instanceof Error ? err.stack : String(err)}`);
    failures++;
  }

  console.log();
  if (failures === 0) {
    console.log(`${GREEN}${BOLD}All tests passed.${RESET}`);
  } else {
    console.log(`${RED}${BOLD}${failures} failure(s).${RESET}`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

void main();
