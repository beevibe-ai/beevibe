import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliProcessOptions, CliProcessResult } from "./claude-code/spawn.js";
import * as spawnModule from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  buildCliEnv,
  cancelledResult,
  createStdoutLineReader,
  finalizeCliResult,
  runCliEventStream,
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

// ─────────────────────────────────────────────────────────────────────────
// runCliEventStream — the spawn/stream/roll-up pipeline shared by every
// CLI runtime. Events here are a toy `{ n }` shape; the real provider
// schemas are exercised in each adapter's own runtime.test.ts.
// ─────────────────────────────────────────────────────────────────────────

interface ToyEvent {
  n: number;
}

let runCliSpy: ReturnType<typeof vi.spyOn>;
let lastOptions: CliProcessOptions | undefined;

function mockRunCli(result: CliProcessResult): void {
  runCliSpy.mockImplementation(async (options) => {
    lastOptions = options;
    if (result.pid !== null) {
      options.onSpawn?.({
        pid: result.pid,
        process_group_id: result.process_group_id ?? result.pid,
      });
    }
    if (result.stdout) options.onLog?.("stdout", result.stdout);
    return result;
  });
}

function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    intent: "do a thing",
    workspace: { path: "/tmp/beevibe-test-ws" },
    system_prompt_append: "",
    ...overrides,
  };
}

function toyStream(
  context: RuntimeContext,
  overrides: Partial<Parameters<typeof runCliEventStream<ToyEvent>>[0]> = {},
): Promise<RuntimeResult> {
  return runCliEventStream<ToyEvent>({
    runtimeTag: "ToyRuntime",
    command: "toy",
    args: ["--json"],
    cwd: context.workspace.path,
    env: { PATH: "/usr/bin" },
    context,
    parseLine: (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return null;
      return JSON.parse(trimmed) as ToyEvent;
    },
    extractSteps: (evt) => [
      { kind: "agent", description: `n=${evt.n}`, timestamp: "t" } as RuntimeStep,
    ],
    buildResult: (events, exitCode) => ({
      status: exitCode === 0 ? "completed" : "failed",
      output: events.map((e) => e.n).join(","),
    }),
    ...overrides,
  });
}

describe("runCliEventStream", () => {
  beforeEach(() => {
    lastOptions = undefined;
    runCliSpy = vi.spyOn(spawnModule, "runCliProcess");
  });

  afterEach(() => {
    runCliSpy.mockRestore();
  });

  it("forwards command, args, cwd, env and stdin to the spawn layer", async () => {
    mockRunCli(cliResult());
    await toyStream(ctx(), { stdin: "piped intent" });

    expect(lastOptions?.command).toBe("toy");
    expect(lastOptions?.args).toEqual(["--json"]);
    expect(lastOptions?.cwd).toBe("/tmp/beevibe-test-ws");
    expect(lastOptions?.env).toEqual({ PATH: "/usr/bin" });
    expect(lastOptions?.stdin).toBe("piped intent");
  });

  it("collects every parsed event and hands them to buildResult in order", async () => {
    mockRunCli(cliResult({ stdout: '{"n":1}\n{"n":2}\n{"n":3}\n' }));
    const result = await toyStream(ctx());

    expect(result.output).toBe("1,2,3");
    expect(result.status).toBe("completed");
  });

  it("skips lines the parser rejects rather than failing the run", async () => {
    mockRunCli(cliResult({ stdout: 'noise\n{"n":1}\n\n{"n":2}\n' }));
    const result = await toyStream(ctx());

    expect(result.output).toBe("1,2");
  });

  it("emits a RuntimeStep per event while the stream is live", async () => {
    mockRunCli(cliResult({ stdout: '{"n":7}\n{"n":8}\n' }));
    const steps: RuntimeStep[] = [];
    await toyStream(ctx({ onStep: (s) => steps.push(s) }));

    expect(steps.map((s) => s.description)).toEqual(["n=7", "n=8"]);
  });

  it("still collects events when the caller registered no onStep", async () => {
    mockRunCli(cliResult({ stdout: '{"n":5}\n' }));
    const result = await toyStream(ctx());

    expect(result.output).toBe("5");
  });

  it("flushes a trailing line that arrived without a newline", async () => {
    mockRunCli(cliResult({ stdout: '{"n":1}\n{"n":2}' }));
    const result = await toyStream(ctx());

    expect(result.output).toBe("1,2");
  });

  it("relays spawn metadata to context.onSpawn", async () => {
    mockRunCli(cliResult({ pid: 1234, process_group_id: 1234 }));
    const spawned: Array<{ process_pid: number; process_group_id: number }> = [];
    await toyStream(ctx({ onSpawn: (m) => spawned.push(m) }));

    expect(spawned).toEqual([{ process_pid: 1234, process_group_id: 1234 }]);
  });

  it("merges process metadata and the stderr tail onto a failed result", async () => {
    mockRunCli(cliResult({ exitCode: 2, stderr: "boom", pid: 77, process_group_id: 77 }));
    const result = await toyStream(ctx());

    expect(result.status).toBe("failed");
    expect(result.exit_code).toBe(2);
    expect(result.process_pid).toBe(77);
    expect(result.stderr).toBe("boom");
  });

  it("short-circuits an abort to cancelled without calling buildResult", async () => {
    mockRunCli(cliResult({ aborted: true, exitCode: null, stdout: '{"n":1}\n' }));
    const buildResult = vi.fn();
    const result = await toyStream(ctx(), { buildResult });

    expect(result.status).toBe("cancelled");
    expect(buildResult).not.toHaveBeenCalled();
  });

  it("runs onAborted on the abort path only", async () => {
    const onAborted = vi.fn();

    mockRunCli(cliResult({ aborted: true, exitCode: null }));
    await toyStream(ctx(), { onAborted });
    expect(onAborted).toHaveBeenCalledTimes(1);

    mockRunCli(cliResult());
    await toyStream(ctx(), { onAborted });
    expect(onAborted).toHaveBeenCalledTimes(1);
  });

  it("warns once with the runtime tag when stdout was capped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunCli(cliResult({ truncated: true }));
    await toyStream(ctx());

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[ToyRuntime]");
    warn.mockRestore();
  });
});

describe("buildCliEnv", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("inherits the executor's environment", () => {
    process.env.BEEVIBE_TEST_INHERITED = "yes";
    expect(buildCliEnv(ctx()).BEEVIBE_TEST_INHERITED).toBe("yes");
  });

  it("strips the named variables so the CLI uses its own credentials", () => {
    process.env.BEEVIBE_TEST_SECRET = "leaked";
    const env = buildCliEnv(ctx(), ["BEEVIBE_TEST_SECRET"]);

    expect(env.BEEVIBE_TEST_SECRET).toBeUndefined();
  });

  it("applies context.env on top of the inherited environment", () => {
    const env = buildCliEnv(ctx({ env: { BEEVIBE_SESSION_ID: "sess_1" } }));

    expect(env.BEEVIBE_SESSION_ID).toBe("sess_1");
  });

  it("lets context.env re-add a stripped variable — the merge runs after the strip", () => {
    process.env.BEEVIBE_TEST_SECRET = "from-shell";
    const env = buildCliEnv(ctx({ env: { BEEVIBE_TEST_SECRET: "deliberate" } }), [
      "BEEVIBE_TEST_SECRET",
    ]);

    expect(env.BEEVIBE_TEST_SECRET).toBe("deliberate");
  });

  it("leaves the environment untouched when nothing is stripped or overridden", () => {
    process.env.BEEVIBE_TEST_PLAIN = "kept";
    const env = buildCliEnv(ctx());

    expect(env.BEEVIBE_TEST_PLAIN).toBe("kept");
  });
});
