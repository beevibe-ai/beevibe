/**
 * End-to-end smoke test for `OpenCodeRuntime`. Mirrors test-codex-runtime.ts
 * structure (basic / MCP / abort / per-session isolation) but exercises
 * opencode's specifics:
 *
 *   - MCP config is written to <workspace>/opencode.json via prepareWorkspace
 *     (NOT passed as CLI args like codex)
 *   - Per-session sid lives in the X-Beevibe-Session HEADER, interpolated
 *     by opencode from `{env:BEEVIBE_SESSION_ID}` at request time
 *   - Per-agent bearer lives in the Authorization header, baked into
 *     opencode.json once by prepareWorkspace
 *   - Usage is summed across step_finish events (no terminal rollup)
 *
 * Requires:
 *   - `opencode` CLI on PATH (you confirmed v1.15.4 is installed)
 *   - At least one provider configured via `opencode auth login`
 *
 * Run:   pnpm tsx scripts/test-opencode-runtime.ts
 *        OPENCODE_TEST_MODEL=anthropic/claude-haiku-4-5 pnpm tsx scripts/test-opencode-runtime.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { OpenCodeRuntime } from "../packages/core/src/adapters/opencode/runtime.js";
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

// Let opencode pick from `~/.config/opencode/opencode.jsonc` unless
// the caller explicitly overrides — auth state per provider determines
// what's available.
const TEST_MODEL = process.env.OPENCODE_TEST_MODEL;

function mkWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "beevibe-opencode-test-"));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

interface InboundRequest {
  method: string;
  url: string;
  /** All headers we care about (Authorization + X-Beevibe-Session). */
  authHeader?: string;
  beevibeSessionHeader?: string;
  bodyHead?: string;
}

interface McpServerHandle {
  url: string;
  toolCalls: Array<{ name: string; args: unknown }>;
  requestLog: InboundRequest[];
  close: () => Promise<void>;
}

/**
 * Echo MCP server. Logs Authorization + X-Beevibe-Session headers so the
 * test can verify opencode's per-session header interpolation worked.
 */
async function startEchoMcpServer(): Promise<McpServerHandle> {
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  const requestLog: InboundRequest[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();

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
    const sidHeader =
      typeof req.headers["x-beevibe-session"] === "string"
        ? req.headers["x-beevibe-session"]
        : undefined;

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyStr = Buffer.concat(chunks).toString("utf8");
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;
    requestLog.push({
      method: req.method ?? "?",
      url: req.url ?? "?",
      authHeader: auth.slice(0, 30) + "…",
      beevibeSessionHeader: sidHeader,
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

async function test1Basic(): Promise<void> {
  banner("Test 1: basic spawn + parse (no MCP)");
  const ws = mkWorkspace();
  try {
    const rt = new OpenCodeRuntime(TEST_MODEL ? { model: TEST_MODEL } : {});
    const steps: RuntimeStep[] = [];
    info(`workspace: ${ws}`);
    if (TEST_MODEL) info(`model: ${TEST_MODEL}`);

    const t0 = Date.now();
    const result = await rt.execute({
      intent:
        "Reply with exactly the words: hello from opencode. Do not run any tools. Do not explain.",
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
      `usage: input=${result.usage?.input_tokens} output=${result.usage?.output_tokens} cache_read=${result.usage?.cache_read_input_tokens} cost=${result.usage?.cost_usd}`,
    );
    if (result.stderr) info(`stderr tail: ${result.stderr.slice(-200).replace(/\n/g, " ")}`);

    if (result.status !== "completed") {
      fail(`expected status=completed, got ${result.status}`);
      if (result.stderr) info(`(provider auth missing?  ${result.stderr.slice(-300)})`);
      failures++;
      return;
    }
    ok("status=completed");

    if (!result.cli_session_id) {
      fail("expected cli_session_id (opencode sessionID) to be parsed");
      failures++;
    } else {
      ok(`cli_session_id parsed: ${result.cli_session_id}`);
    }

    if (!result.output?.toLowerCase().includes("hello from opencode")) {
      fail(`expected output to contain "hello from opencode", got: ${result.output}`);
      failures++;
    } else {
      ok('output contains "hello from opencode"');
    }

    // opencode v1.15.4 only emits `step_finish` events when the turn
    // includes a tool call — pure text turns get `step_start` + `text`
    // and nothing else. Test 2 verifies the tool-call usage path; for
    // this text-only turn, missing usage is expected behavior.
    if (!result.usage) {
      info("(usage absent — opencode skips step_finish for text-only turns; test 2 verifies the tool-call path)");
    } else {
      ok("usage parsed by summing step_finish events");
    }

    const agentSteps = steps.filter((s) => s.kind === "agent");
    if (agentSteps.length === 0) {
      fail("expected at least one onStep agent emit from text part");
      failures++;
    } else {
      ok(`${agentSteps.length} agent step(s) streamed via onStep`);
    }
  } finally {
    cleanup(ws);
  }
}

async function test2Mcp(): Promise<void> {
  banner("Test 2: MCP connection (opencode → in-process echo server)");
  const ws = mkWorkspace();
  const sid = `sess_${randomUUID().slice(0, 8)}`;
  let mcp: McpServerHandle | undefined;
  try {
    mcp = await startEchoMcpServer();
    info(`mcp echo server: ${mcp.url}`);
    info(`workspace: ${ws}`);
    info(`session id: ${sid}`);

    const rt = new OpenCodeRuntime(TEST_MODEL ? { model: TEST_MODEL } : {});
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
      info(
        `  ${r.method} ${r.url} auth=${r.authHeader} X-Beevibe-Session=${r.beevibeSessionHeader ?? "<none>"} body=${r.bodyHead?.slice(0, 80)}…`,
      );
    }
    if (result.stderr) {
      info(`stderr tail: ${result.stderr.slice(-300).replace(/\n/g, " ")}`);
    }

    if (result.status !== "completed") {
      fail(`expected status=completed, got ${result.status}; stderr: ${result.stderr?.slice(-500)}`);
      failures++;
      return;
    }
    ok("status=completed");

    if (mcp.toolCalls.length === 0) {
      fail(
        "expected at least one tools/call to the echo server — MCP connection / opencode.json wiring broken",
      );
      failures++;
    } else {
      const first = mcp.toolCalls[0]!;
      ok(`MCP server received tools/call: ${first.name} ${JSON.stringify(first.args)}`);
    }

    // The crucial opencode-specific assertion: per-session sid lives in
    // the X-Beevibe-Session HEADER (interpolated from {env:BEEVIBE_SESSION_ID}),
    // not the URL. If opencode didn't interpolate, we'd see the literal
    // string `{env:BEEVIBE_SESSION_ID}` or nothing at all.
    const sidHeaders = mcp.requestLog.map((r) => r.beevibeSessionHeader).filter(Boolean);
    if (sidHeaders.length === 0) {
      fail("no X-Beevibe-Session header on any request — env-var interpolation broken");
      failures++;
    } else if (sidHeaders.some((h) => h !== sid)) {
      fail(
        `X-Beevibe-Session carried wrong sid: expected ${sid}, got ${JSON.stringify(
          Array.from(new Set(sidHeaders)),
        )}`,
      );
      failures++;
    } else {
      ok(`X-Beevibe-Session header carried sid=${sid} on ${sidHeaders.length} request(s)`);
    }

    if (!result.output?.toLowerCase().includes("echoed: ping")) {
      fail(`expected opencode output to contain "echoed: ping", got: ${result.output}`);
      failures++;
    } else {
      ok('output includes "echoed: ping" — tool round-trip succeeded');
    }

    // Usage assertion lives here (not test 1) because opencode only
    // emits step_finish events when a turn has tool calls. The MCP
    // round-trip above guarantees a step_finish, so usage should be
    // non-zero AND properly summed across all emitted step_finish events.
    if (!result.usage || (result.usage.input_tokens ?? 0) === 0) {
      fail("expected non-zero usage from step_finish event(s)");
      failures++;
    } else {
      ok(
        `usage parsed: input=${result.usage.input_tokens} output=${result.usage.output_tokens} cache_read=${result.usage.cache_read_input_tokens} cost=${result.usage.cost_usd}`,
      );
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
    const rt = new OpenCodeRuntime(TEST_MODEL ? { model: TEST_MODEL } : {});
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
      if (result.stderr) info(`stderr: ${result.stderr.slice(-300)}`);
      failures++;
    } else {
      ok("status=cancelled");
    }

    if (elapsed > 20_000) {
      fail(`abort took ${elapsed}ms — should have settled within a few seconds of abort signal`);
      failures++;
    } else {
      ok(`abort settled within ${elapsed}ms`);
    }

    if (pidSeen !== undefined) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        process.kill(pidSeen, 0);
        fail(`process pid=${pidSeen} still alive after abort — zombie`);
        failures++;
      } catch (err) {
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
  // The opencode equivalent of claude's ${BEEVIBE_SESSION_ID} env
  // interpolation: opencode.json has `X-Beevibe-Session: {env:BEEVIBE_SESSION_ID}`
  // baked in once by prepareWorkspace; each spawn provides its own
  // BEEVIBE_SESSION_ID env var, and opencode interpolates per-request.
  // Two concurrent spawns sharing one MCP server must each produce
  // headers carrying their own sid + their own bearer.
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

    const rtA = new OpenCodeRuntime(TEST_MODEL ? { model: TEST_MODEL } : {});
    rtA.prepareWorkspace({
      workspace: { path: wsA },
      agentApiKey: "bv_a_token_A",
      mcpServerUrl: mcp.url,
    });
    const rtB = new OpenCodeRuntime(TEST_MODEL ? { model: TEST_MODEL } : {});
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

    const toolCallRequests = mcp.requestLog.filter((r) =>
      r.bodyHead?.includes('"method":"tools/call"'),
    );
    info(`server saw ${toolCallRequests.length} tools/call POSTs:`);
    for (const r of toolCallRequests) {
      info(
        `  url=${r.url} auth=${r.authHeader} X-Beevibe-Session=${r.beevibeSessionHeader ?? "<none>"}`,
      );
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

    // Decouple A vs B by the X-Beevibe-Session header (not URL — opencode
    // puts sid in the header, not the URL query).
    const callA = toolCallRequests.find((r) => r.beevibeSessionHeader === sidA);
    const callB = toolCallRequests.find((r) => r.beevibeSessionHeader === sidB);

    if (!callA) {
      fail(`no tools/call had X-Beevibe-Session=${sidA} — spawn A's sid was lost or swapped`);
      failures++;
    } else {
      ok(`spawn A's tools/call header X-Beevibe-Session=${sidA}`);
      if (!callA.authHeader?.includes("bv_a_token_A")) {
        fail(`spawn A's tools/call had wrong bearer (auth=${callA.authHeader})`);
        failures++;
      } else {
        ok("spawn A's bearer token matched (no opencode.json cross-leak)");
      }
      if (!resultA.output?.includes("from-A")) {
        fail(`spawn A's output didn't round-trip "from-A": ${resultA.output}`);
        failures++;
      } else {
        ok('spawn A round-tripped "from-A" through echo tool');
      }
    }

    if (!callB) {
      fail(`no tools/call had X-Beevibe-Session=${sidB} — spawn B's sid was lost or swapped`);
      failures++;
    } else {
      ok(`spawn B's tools/call header X-Beevibe-Session=${sidB}`);
      if (!callB.authHeader?.includes("bv_a_token_B")) {
        fail(`spawn B's tools/call had wrong bearer (auth=${callB.authHeader})`);
        failures++;
      } else {
        ok("spawn B's bearer token matched (no opencode.json cross-leak)");
      }
      if (!resultB.output?.includes("from-B")) {
        fail(`spawn B's output didn't round-trip "from-B": ${resultB.output}`);
        failures++;
      } else {
        ok('spawn B round-tripped "from-B" through echo tool');
      }
    }

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
  console.log(`${BOLD}OpenCodeRuntime end-to-end test${RESET}`);
  console.log(
    `${DIM}Requires opencode CLI on PATH + at least one provider via \`opencode auth login\`.${RESET}`,
  );
  if (TEST_MODEL) {
    console.log(`${DIM}Using model: ${TEST_MODEL}${RESET}`);
  } else {
    console.log(`${DIM}Letting opencode pick from ~/.config/opencode/opencode.jsonc.${RESET}`);
    console.log(
      `${DIM}Override with: OPENCODE_TEST_MODEL=<provider>/<model> pnpm tsx scripts/test-opencode-runtime.ts${RESET}`,
    );
  }

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
