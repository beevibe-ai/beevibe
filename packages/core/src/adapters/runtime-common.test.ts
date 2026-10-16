import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliProcessOptions, CliProcessResult } from "./claude-code/spawn.js";
import * as spawnModule from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
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

describe("runCliSession", () => {
  interface Evt {
    n: number;
  }

  const NOW = "2026-01-01T00:00:00.000Z";

  function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
    return {
      intent: "do a thing",
      workspace: { path: "/tmp/beevibe-run-cli-session" },
      system_prompt_append: "",
      ...overrides,
    };
  }

  /** Replay `stdout` through the driver's onLog, then resolve with `result`. */
  function mockRunCli(stdout: string, result: Partial<CliProcessResult> = {}): void {
    const settled = cliResult(result);
    vi.spyOn(spawnModule, "runCliProcess").mockImplementation(async (options) => {
      lastOptions = options;
      if (settled.pid !== null) {
        options.onSpawn?.({
          pid: settled.pid,
          process_group_id: settled.process_group_id ?? settled.pid,
        });
      }
      if (stdout) options.onLog?.("stdout", stdout);
      return settled;
    });
  }

  let lastOptions: CliProcessOptions | undefined;

  /** Accepts `{"n":N}` lines, rejects everything else. */
  const parseLine = (line: string): Evt | null => {
    try {
      const v = JSON.parse(line) as Evt;
      return typeof v.n === "number" ? v : null;
    } catch {
      return null;
    }
  };

  function spec(overrides: Record<string, unknown> = {}) {
    return {
      tag: "TestRuntime",
      context: ctx(),
      spawn: { command: "fake-cli", args: ["--json"], cwd: "/tmp" },
      parseLine,
      extractSteps: (): RuntimeStep[] => [],
      parseResult: (events: Evt[]): RuntimeResult => ({
        status: "completed" as const,
        output: events.map((e) => e.n).join(","),
      }),
      ...overrides,
    };
  }

  beforeEach(() => {
    lastOptions = undefined;
  });

  afterEach(() => vi.restoreAllMocks());

  it("hands every parsed event to parseResult, in stream order", async () => {
    mockRunCli('{"n":1}\n{"n":2}\n{"n":3}\n');
    const out = await runCliSession<Evt>(spec());
    expect(out.output).toBe("1,2,3");
  });

  it("skips lines that don't parse instead of failing the session", async () => {
    mockRunCli('{"n":1}\nnot json at all\n{"bogus":true}\n{"n":2}\n');
    const out = await runCliSession<Evt>(spec());
    expect(out.output).toBe("1,2");
  });

  it("flushes a trailing line that arrived without a newline", async () => {
    mockRunCli('{"n":1}\n{"n":2}');
    const out = await runCliSession<Evt>(spec());
    expect(out.output).toBe("1,2");
  });

  it("streams a step per event when the caller is listening", async () => {
    mockRunCli('{"n":1}\n{"n":2}\n');
    const steps: RuntimeStep[] = [];
    await runCliSession<Evt>(
      spec({
        context: ctx({ onStep: (s: RuntimeStep) => steps.push(s) }),
        extractSteps: (e: Evt): RuntimeStep[] => [
          { kind: "tool_call", description: `step ${e.n}`, timestamp: NOW },
        ],
      }),
    );
    expect(steps.map((s) => s.description)).toEqual(["step 1", "step 2"]);
  });

  it("doesn't extract steps at all when no onStep is set", async () => {
    mockRunCli('{"n":1}\n{"n":2}\n');
    const extractSteps = vi.fn((): RuntimeStep[] => []);
    const out = await runCliSession<Evt>(spec({ extractSteps }));
    // Events still collected — only the per-event step mapping is skipped.
    expect(out.output).toBe("1,2");
    expect(extractSteps).not.toHaveBeenCalled();
  });

  it("binds the abort signal and re-shapes onSpawn for the context", async () => {
    const controller = new AbortController();
    const spawned: Array<{ process_pid: number; process_group_id: number }> = [];
    mockRunCli("");
    await runCliSession<Evt>(
      spec({
        context: ctx({
          abort_signal: controller.signal,
          onSpawn: (meta: { process_pid: number; process_group_id: number }) =>
            spawned.push(meta),
        }),
      }),
    );
    expect(lastOptions?.abortSignal).toBe(controller.signal);
    expect(spawned).toEqual([{ process_pid: 4242, process_group_id: 4242 }]);
  });

  it("passes the adapter's spawn options straight through", async () => {
    mockRunCli("");
    await runCliSession<Evt>(
      spec({
        spawn: {
          command: "codex",
          args: ["exec", "--json"],
          cwd: "/work",
          env: { FOO: "bar" },
          stdin: "the intent",
        },
      }),
    );
    expect(lastOptions?.command).toBe("codex");
    expect(lastOptions?.args).toEqual(["exec", "--json"]);
    expect(lastOptions?.cwd).toBe("/work");
    expect(lastOptions?.env).toEqual({ FOO: "bar" });
    expect(lastOptions?.stdin).toBe("the intent");
  });

  it("merges process metadata onto the parsed result", async () => {
    mockRunCli('{"n":1}\n', { exitCode: 0 });
    const out = await runCliSession<Evt>(spec());
    expect(out).toMatchObject({
      status: "completed",
      process_pid: 4242,
      process_group_id: 4242,
      exit_code: 0,
    });
  });

  it("reports an aborted run as cancelled without parsing it", async () => {
    mockRunCli('{"n":1}\n', { aborted: true });
    const parseResult = vi.fn();
    const out = await runCliSession<Evt>(spec({ parseResult }));
    expect(out.status).toBe("cancelled");
    expect(parseResult).not.toHaveBeenCalled();
  });

  it("runs cleanup on the aborted path", async () => {
    mockRunCli("", { aborted: true });
    const cleanup = vi.fn();
    await runCliSession<Evt>(spec({ cleanup }));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs cleanup after parseResult, so the parser can still read it", async () => {
    mockRunCli('{"n":1}\n');
    const order: string[] = [];
    await runCliSession<Evt>(
      spec({
        parseResult: (): RuntimeResult => {
          order.push("parse");
          return { status: "completed", output: "" };
        },
        cleanup: () => order.push("cleanup"),
      }),
    );
    expect(order).toEqual(["parse", "cleanup"]);
  });

  it("warns under the adapter's tag when stdout was capped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunCli('{"n":1}\n', { truncated: true });
    await runCliSession<Evt>(spec());
    expect(warn.mock.calls[0]![0]).toContain("[TestRuntime]");
  });
});
