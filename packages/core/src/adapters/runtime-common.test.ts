import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessOptions, CliProcessResult } from "./claude-code/spawn.js";
import * as spawnModule from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  buildRuntimeEnv,
  cancelledResult,
  createStdoutLineReader,
  finalizeCliResult,
  runCliSession,
  warnIfTruncated,
} from "./runtime-common.js";

function cliResult(overrides: Partial<CliProcessResult> = {}): CliProcessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    aborted: false,
    pid: 4242,
    process_group_id: 4242,
    truncated: false,
    ...overrides,
  };
}

describe("createStdoutLineReader", () => {
  it("emits one call per complete line", () => {
    const lines: string[] = [];
    const reader = createStdoutLineReader((l) => lines.push(l));
    reader.onLog("stdout", "a\nb\nc\n");
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("reassembles a line split across chunks", () => {
    const lines: string[] = [];
    const reader = createStdoutLineReader((l) => lines.push(l));
    reader.onLog("stdout", '{"ty');
    reader.onLog("stdout", 'pe":"x"}');
    // Nothing emitted until the newline arrives.
    expect(lines).toEqual([]);
    reader.onLog("stdout", "\n");
    expect(lines).toEqual(['{"type":"x"}']);
  });

  it("emits several lines arriving in a single chunk", () => {
    const lines: string[] = [];
    const reader = createStdoutLineReader((l) => lines.push(l));
    reader.onLog("stdout", "one\ntwo\nthr");
    expect(lines).toEqual(["one", "two"]);
    reader.flush();
    expect(lines).toEqual(["one", "two", "thr"]);
  });

  it("ignores stderr chunks", () => {
    const lines: string[] = [];
    const reader = createStdoutLineReader((l) => lines.push(l));
    reader.onLog("stderr", "warning: noise\n");
    reader.flush();
    expect(lines).toEqual([]);
  });

  it("flush is a no-op when the stream ended on a newline", () => {
    const lines: string[] = [];
    const reader = createStdoutLineReader((l) => lines.push(l));
    reader.onLog("stdout", "done\n");
    reader.flush();
    reader.flush();
    expect(lines).toEqual(["done"]);
  });

  it("preserves empty lines between records", () => {
    const lines: string[] = [];
    const reader = createStdoutLineReader((l) => lines.push(l));
    reader.onLog("stdout", "a\n\nb\n");
    expect(lines).toEqual(["a", "", "b"]);
  });
});

describe("warnIfTruncated", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns with the runtime tag when stdout was capped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfTruncated("CodexRuntime", cliResult({ truncated: true }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("[CodexRuntime]");
  });

  it("stays quiet when the stream was complete", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfTruncated("CodexRuntime", cliResult({ truncated: false }));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("cancelledResult", () => {
  it("reports cancelled — distinct from a failure — with process metadata", () => {
    expect(cancelledResult(cliResult({ aborted: true }))).toEqual({
      status: "cancelled",
      output: "Session cancelled.",
      process_pid: 4242,
      process_group_id: 4242,
    });
  });

  it("maps a null pid (spawn failure) to undefined", () => {
    const result = cancelledResult(cliResult({ pid: null, process_group_id: null }));
    expect(result.process_pid).toBeUndefined();
    expect(result.process_group_id).toBeUndefined();
  });
});

describe("finalizeCliResult", () => {
  const parsed: RuntimeResult = { status: "completed", output: "hi" };

  it("merges process metadata onto the parsed result", () => {
    expect(finalizeCliResult(parsed, cliResult({ exitCode: 0 }))).toEqual({
      status: "completed",
      output: "hi",
      process_pid: 4242,
      process_group_id: 4242,
      exit_code: 0,
    });
  });

  it("omits stderr when the run succeeded", () => {
    const out = finalizeCliResult(parsed, cliResult({ stderr: "chatty but fine" }));
    expect(out.stderr).toBeUndefined();
  });

  it("surfaces the stderr tail on failure", () => {
    const failed: RuntimeResult = { status: "failed", output: "" };
    const out = finalizeCliResult(failed, cliResult({ stderr: "boom", exitCode: 1 }));
    expect(out.stderr).toBe("boom");
    expect(out.exit_code).toBe(1);
  });

  it("tail-slices stderr to 4KB, keeping the end where the error is", () => {
    const failed: RuntimeResult = { status: "failed", output: "" };
    const stderr = "x".repeat(5000) + "FINAL_ERROR";
    const out = finalizeCliResult(failed, cliResult({ stderr, exitCode: 1 }));
    expect(out.stderr).toHaveLength(4096);
    expect(out.stderr!.endsWith("FINAL_ERROR")).toBe(true);
  });

  it("omits stderr on failure when the CLI wrote nothing", () => {
    const failed: RuntimeResult = { status: "failed", output: "" };
    expect(finalizeCliResult(failed, cliResult({ stderr: "", exitCode: 1 })).stderr).toBeUndefined();
  });
});

// ── runCliSession ─────────────────────────────────────────────────────────

/** Minimal RuntimeContext; each test overrides just what it exercises. */
function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    intent: "do the thing",
    workspace: { path: "/tmp/ws" },
    system_prompt_append: "",
    ...overrides,
  } as RuntimeContext;
}

/** A trivial event schema: one `{n: number}` object per line. */
interface NumEvent {
  n: number;
}

function numSpec(
  overrides: Partial<Parameters<typeof runCliSession<NumEvent>>[1]> = {},
): Parameters<typeof runCliSession<NumEvent>>[1] {
  return {
    runtimeTag: "TestRuntime",
    command: "fake-cli",
    args: ["--go"],
    cwd: "/tmp/ws",
    env: { PATH: "/usr/bin" },
    parseLine: (line) => {
      const t = line.trim();
      if (!t.startsWith("{")) return null;
      return JSON.parse(t) as NumEvent;
    },
    extractSteps: (evt) => [
      { kind: "agent", description: `n=${evt.n}` } as RuntimeStep,
    ],
    parseResult: (events, exitCode) => ({
      status: exitCode === 0 ? "completed" : "failed",
      output: events.map((e) => e.n).join(","),
    }),
    ...overrides,
  };
}

describe("runCliSession", () => {
  let runCliSpy: ReturnType<typeof vi.spyOn>;
  let lastOptions: CliProcessOptions | undefined;

  function mockRunCli(result: Partial<CliProcessResult>, stdoutChunks?: string[]): void {
    const full = cliResult(result);
    runCliSpy = vi.spyOn(spawnModule, "runCliProcess").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/require-await
      async (options) => {
        lastOptions = options;
        if (full.pid !== null) {
          options.onSpawn?.({
            pid: full.pid,
            process_group_id: full.process_group_id ?? full.pid,
          });
        }
        for (const chunk of stdoutChunks ?? (full.stdout ? [full.stdout] : [])) {
          options.onLog?.("stdout", chunk);
        }
        return full;
      },
    );
  }

  afterEach(() => {
    runCliSpy?.mockRestore();
    lastOptions = undefined;
    vi.restoreAllMocks();
  });

  it("passes the spec's command, argv, cwd, env and stdin through to the spawn", async () => {
    mockRunCli({ stdout: "" });
    await runCliSession(ctx(), numSpec({ stdin: "piped intent" }));

    expect(lastOptions?.command).toBe("fake-cli");
    expect(lastOptions?.args).toEqual(["--go"]);
    expect(lastOptions?.cwd).toBe("/tmp/ws");
    expect(lastOptions?.env).toEqual({ PATH: "/usr/bin" });
    expect(lastOptions?.stdin).toBe("piped intent");
  });

  it("collects parsed events and hands them to parseResult with the exit code", async () => {
    mockRunCli({ stdout: '{"n":1}\n{"n":2}\n', exitCode: 0 });
    const result = await runCliSession(ctx(), numSpec());
    expect(result.output).toBe("1,2");
    expect(result.status).toBe("completed");
    expect(result.exit_code).toBe(0);
  });

  it("skips lines parseLine rejects rather than failing the run", async () => {
    mockRunCli({ stdout: 'npm WARN noise\n{"n":7}\n\n' });
    const result = await runCliSession(ctx(), numSpec());
    expect(result.output).toBe("7");
  });

  it("emits a step per event when onStep is supplied", async () => {
    mockRunCli({ stdout: '{"n":1}\n{"n":2}\n' });
    const steps: RuntimeStep[] = [];
    await runCliSession(ctx({ onStep: (s) => steps.push(s) }), numSpec());
    expect(steps.map((s) => s.description)).toEqual(["n=1", "n=2"]);
  });

  it("never calls extractSteps when the caller supplied no onStep", async () => {
    mockRunCli({ stdout: '{"n":1}\n' });
    const extractSteps = vi.fn(() => []);
    await runCliSession(ctx(), numSpec({ extractSteps }));
    expect(extractSteps).not.toHaveBeenCalled();
  });

  it("flushes a trailing partial line, so the last event is not dropped", async () => {
    // No trailing newline — the event only reaches parseResult via flush().
    mockRunCli({ stdout: '{"n":1}\n{"n":2}' });
    const result = await runCliSession(ctx(), numSpec());
    expect(result.output).toBe("1,2");
  });

  it("reassembles an event split across stdout chunks", async () => {
    mockRunCli({ stdout: "" }, ['{"n', '":42}', "\n"]);
    const result = await runCliSession(ctx(), numSpec());
    expect(result.output).toBe("42");
  });

  it("forwards the spawn metadata to context.onSpawn", async () => {
    mockRunCli({ stdout: "", pid: 321, process_group_id: 321 });
    const seen: Array<{ process_pid: number; process_group_id: number }> = [];
    await runCliSession(ctx({ onSpawn: (m) => seen.push(m) }), numSpec());
    expect(seen).toEqual([{ process_pid: 321, process_group_id: 321 }]);
  });

  it("reports an aborted run as cancelled without parsing the events", async () => {
    mockRunCli({ stdout: '{"n":1}\n', aborted: true, exitCode: null });
    const parseResult = vi.fn();
    const result = await runCliSession(ctx(), numSpec({ parseResult }));
    expect(result.status).toBe("cancelled");
    expect(result.output).toBe("Session cancelled.");
    expect(parseResult).not.toHaveBeenCalled();
  });

  it("runs cleanup on the abort path", async () => {
    mockRunCli({ aborted: true });
    const cleanup = vi.fn();
    await runCliSession(ctx(), numSpec({ cleanup }));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs cleanup after parseResult on the normal path", async () => {
    // Codex depends on this order: parseResult reads the scratch file that
    // cleanup then deletes.
    mockRunCli({ stdout: '{"n":1}\n' });
    const order: string[] = [];
    await runCliSession(
      ctx(),
      numSpec({
        parseResult: () => {
          order.push("parse");
          return { status: "completed", output: "" };
        },
        cleanup: () => order.push("cleanup"),
      }),
    );
    expect(order).toEqual(["parse", "cleanup"]);
  });

  it("merges the process metadata and stderr tail into the parsed result", async () => {
    mockRunCli({ stdout: "", exitCode: 2, stderr: "boom", pid: 77, process_group_id: 77 });
    const result = await runCliSession(ctx(), numSpec());
    expect(result.status).toBe("failed");
    expect(result.exit_code).toBe(2);
    expect(result.process_pid).toBe(77);
    expect(result.stderr).toBe("boom");
  });

  it("warns once when stdout was truncated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunCli({ stdout: "", truncated: true });
    await runCliSession(ctx(), numSpec());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[TestRuntime]");
  });
});

// ── buildRuntimeEnv ───────────────────────────────────────────────────────

describe("buildRuntimeEnv", () => {
  const SAVED = process.env.BEEVIBE_ENV_TEST_VAR;

  afterEach(() => {
    if (SAVED === undefined) delete process.env.BEEVIBE_ENV_TEST_VAR;
    else process.env.BEEVIBE_ENV_TEST_VAR = SAVED;
  });

  it("inherits the executor's own environment", () => {
    process.env.BEEVIBE_ENV_TEST_VAR = "inherited";
    expect(buildRuntimeEnv(ctx()).BEEVIBE_ENV_TEST_VAR).toBe("inherited");
  });

  it("removes every var named in strip", () => {
    process.env.BEEVIBE_ENV_TEST_VAR = "leaked";
    const env = buildRuntimeEnv(ctx(), { strip: ["BEEVIBE_ENV_TEST_VAR"] });
    expect("BEEVIBE_ENV_TEST_VAR" in env).toBe(false);
  });

  it("lets context.env set a stripped var back deliberately", () => {
    // The strip list is a guard against leakage, not a ban: a dispatch that
    // explicitly supplies the var still wins.
    process.env.BEEVIBE_ENV_TEST_VAR = "leaked";
    const env = buildRuntimeEnv(
      ctx({ env: { BEEVIBE_ENV_TEST_VAR: "deliberate" } }),
      { strip: ["BEEVIBE_ENV_TEST_VAR"] },
    );
    expect(env.BEEVIBE_ENV_TEST_VAR).toBe("deliberate");
  });

  it("applies extra after context.env, so adapter-owned vars win", () => {
    const env = buildRuntimeEnv(ctx({ env: { BEEVIBE_AGENT_API_KEY: "stale" } }), {
      extra: { BEEVIBE_AGENT_API_KEY: "fresh" },
    });
    expect(env.BEEVIBE_AGENT_API_KEY).toBe("fresh");
  });

  it("overlays context.env on the inherited environment", () => {
    const env = buildRuntimeEnv(ctx({ env: { BEEVIBE_SESSION_ID: "sess_1" } }));
    expect(env.BEEVIBE_SESSION_ID).toBe("sess_1");
  });
});
