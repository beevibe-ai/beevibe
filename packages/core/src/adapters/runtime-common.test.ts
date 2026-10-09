import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessOptions, CliProcessResult } from "./claude-code/spawn.js";
import * as spawnModule from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  buildCliEnv,
  cancelledResult,
  createStdoutLineReader,
  finalizeCliResult,
  runCliStreamingSession,
  warnIfTruncated,
  type CliStreamingRun,
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

function runtimeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    intent: "do the thing",
    workspace: { path: "/sandbox/agent_x" },
    system_prompt_append: "",
    ...overrides,
  };
}

describe("buildCliEnv", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("inherits the executor's environment", () => {
    process.env.SOME_INHERITED = "yes";
    expect(buildCliEnv(runtimeContext()).SOME_INHERITED).toBe("yes");
  });

  it("strips the named vars so they can't leak into the subprocess", () => {
    process.env.ANTHROPIC_API_KEY = "sk-leaked";
    process.env.CLAUDECODE = "1";
    const env = buildCliEnv(runtimeContext(), ["ANTHROPIC_API_KEY", "CLAUDECODE"]);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it("merges context.env on top", () => {
    const env = buildCliEnv(runtimeContext({ env: { BEEVIBE_SESSION_ID: "sess_1" } }));
    expect(env.BEEVIBE_SESSION_ID).toBe("sess_1");
  });

  it("lets context.env re-add a stripped var — stripping only drops what leaked in", () => {
    process.env.OPENAI_API_KEY = "sk-from-shell";
    const env = buildCliEnv(runtimeContext({ env: { OPENAI_API_KEY: "sk-deliberate" } }), [
      "OPENAI_API_KEY",
    ]);
    expect(env.OPENAI_API_KEY).toBe("sk-deliberate");
  });

  it("does not mutate process.env", () => {
    process.env.ANTHROPIC_API_KEY = "sk-keep";
    buildCliEnv(runtimeContext(), ["ANTHROPIC_API_KEY"]);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-keep");
  });
});

describe("runCliStreamingSession", () => {
  interface Evt {
    n: number;
  }

  /** `{"n":N}` per line; anything else is skipped like real NDJSON noise. */
  const parseLine = (line: string): Evt | null => {
    const t = line.trim();
    if (!t.startsWith("{")) return null;
    try {
      return JSON.parse(t) as Evt;
    } catch {
      return null;
    }
  };

  function run(
    overrides: Partial<CliStreamingRun<Evt>> = {},
    cli: Partial<CliProcessResult> = {},
    context: RuntimeContext = runtimeContext(),
  ): Promise<RuntimeResult> {
    const result = cliResult(cli);
    vi.spyOn(spawnModule, "runCliProcess").mockImplementation(async (options) => {
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
    return runCliStreamingSession<Evt>(context, {
      runtimeTag: "FakeRuntime",
      command: "fake",
      args: ["--json"],
      env: { PATH: "/usr/bin" },
      parseLine,
      extractSteps: (e) => [
        { kind: "agent", description: `evt ${e.n}`, timestamp: "2026-01-01T00:00:00.000Z" },
      ],
      buildResult: (events, exitCode) => ({
        status: exitCode === 0 ? "completed" : "failed",
        output: events.map((e) => e.n).join(","),
      }),
      ...overrides,
    });
  }

  let lastOptions: CliProcessOptions | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    lastOptions = undefined;
  });

  it("passes argv, env, stdin and the workspace cwd through to the spawn", async () => {
    await run({ stdin: "piped intent" });
    expect(lastOptions?.command).toBe("fake");
    expect(lastOptions?.args).toEqual(["--json"]);
    expect(lastOptions?.env).toEqual({ PATH: "/usr/bin" });
    expect(lastOptions?.stdin).toBe("piped intent");
    // cwd always comes from the context, never the spec — all three
    // runtimes ran the CLI inside the agent's workspace.
    expect(lastOptions?.cwd).toBe("/sandbox/agent_x");
  });

  it("feeds parsed events to buildResult in arrival order", async () => {
    const out = await run({}, { stdout: '{"n":1}\n{"n":2}\n{"n":3}\n' });
    expect(out.output).toBe("1,2,3");
  });

  it("skips unparseable lines rather than failing the run", async () => {
    const out = await run({}, { stdout: 'npm warn noise\n{"n":1}\n{oops\n{"n":2}\n' });
    expect(out.output).toBe("1,2");
  });

  it("parses a final line that arrived without a trailing newline", async () => {
    const out = await run({}, { stdout: '{"n":1}\n{"n":2}' });
    expect(out.output).toBe("1,2");
  });

  it("fans every event's steps out to context.onStep as they arrive", async () => {
    const steps: RuntimeStep[] = [];
    await run({}, { stdout: '{"n":1}\n{"n":2}\n' }, runtimeContext({ onStep: (s) => steps.push(s) }));
    expect(steps.map((s) => s.description)).toEqual(["evt 1", "evt 2"]);
  });

  it("still collects events when the context has no onStep", async () => {
    const out = await run({}, { stdout: '{"n":7}\n' }, runtimeContext({ onStep: undefined }));
    expect(out.output).toBe("7");
  });

  it("forwards spawn metadata to context.onSpawn", async () => {
    const spawns: Array<{ process_pid: number }> = [];
    await run({}, {}, runtimeContext({ onSpawn: (m) => spawns.push(m) }));
    expect(spawns).toEqual([{ process_pid: 4242, process_group_id: 4242 }]);
  });

  it("merges process metadata and the exit code onto the parsed result", async () => {
    const out = await run({}, { stdout: '{"n":1}\n' });
    expect(out).toMatchObject({
      status: "completed",
      output: "1",
      process_pid: 4242,
      process_group_id: 4242,
      exit_code: 0,
    });
  });

  it("surfaces the stderr tail when the CLI exited non-zero", async () => {
    const out = await run({}, { exitCode: 1, stderr: "boom" });
    expect(out.status).toBe("failed");
    expect(out.stderr).toBe("boom");
  });

  it("returns cancelled — not failed — on abort, without parsing a result", async () => {
    const buildResult = vi.fn();
    const out = await run({ buildResult }, { aborted: true, stdout: '{"n":1}\n' });
    expect(out.status).toBe("cancelled");
    expect(out.output).toBe("Session cancelled.");
    expect(buildResult).not.toHaveBeenCalled();
  });

  it("warns once when the CLI's stdout hit the capture cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await run({}, { truncated: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("[FakeRuntime]");
  });

  it("runs cleanup after buildResult, so a result read off disk still sees the file", async () => {
    const order: string[] = [];
    const out = await run({
      buildResult: () => {
        order.push("build");
        return { status: "completed", output: "from disk" };
      },
      cleanup: () => order.push("cleanup"),
    });
    expect(order).toEqual(["build", "cleanup"]);
    expect(out.output).toBe("from disk");
  });

  it("runs cleanup on the abort path too, so nothing is left behind", async () => {
    const cleanup = vi.fn();
    await run({ cleanup }, { aborted: true });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
