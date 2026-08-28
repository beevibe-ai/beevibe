import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessOptions, CliProcessResult } from "./claude-code/spawn.js";
import * as spawnModule from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  cancelledResult,
  createStdoutLineReader,
  finalizeCliResult,
  runNdjsonCliSession,
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

describe("runNdjsonCliSession", () => {
  interface Evt {
    n: number;
  }

  function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
    return {
      intent: "do a thing",
      workspace: { path: "/tmp/agent_x" },
      system_prompt_append: "",
      ...overrides,
    };
  }

  /**
   * Stand-in for the CLI: feeds `chunks` to `onLog` as stdout the way a real
   * subprocess would — arbitrary boundaries, not necessarily line-aligned.
   */
  function mockCli(chunks: string[], overrides: Partial<CliProcessResult> = {}) {
    let seen: CliProcessOptions | undefined;
    const spy = vi.spyOn(spawnModule, "runCliProcess").mockImplementation(async (options) => {
      seen = options;
      const result = cliResult(overrides);
      if (result.pid !== null) {
        options.onSpawn?.({
          pid: result.pid,
          process_group_id: result.process_group_id ?? result.pid,
        });
      }
      for (const chunk of chunks) options.onLog?.("stdout", chunk);
      return result;
    });
    return { spy, options: () => seen };
  }

  const session = (chunks: string[], context = ctx(), overrides: Partial<CliProcessResult> = {}) => {
    const cli = mockCli(chunks, overrides);
    return runNdjsonCliSession<Evt>({
      command: "faux",
      args: ["--json"],
      cwd: "/tmp/agent_x",
      env: { FOO: "bar" },
      runtimeTag: "FauxRuntime",
      context,
      // Mirrors the real parsers: they all funnel through `parseNdjsonLine`,
      // which answers null for a blank or malformed line rather than
      // throwing. `runNdjsonCliSession` relies on that — it does not catch,
      // so a parser that threw would abort the whole run.
      parseLine: (line) => {
        try {
          return line.trim() ? (JSON.parse(line) as Evt) : null;
        } catch {
          return null;
        }
      },
      extractSteps: (evt) => [
        { kind: "agent", description: `step ${evt.n}`, timestamp: "t" },
      ],
    }).then((out) => ({ ...out, cli }));
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects every parsed event in stream order", async () => {
    const { events } = await session(['{"n":1}\n{"n":2}\n', '{"n":3}\n']);
    expect(events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("reassembles an event split across chunks", async () => {
    const { events } = await session(['{"n":', "1}\n"]);
    expect(events).toEqual([{ n: 1 }]);
  });

  // The reason the flush has to live in here and not at each call site: a CLI
  // that exits without a trailing newline would otherwise silently drop its
  // last — often most important — event.
  it("flushes a trailing line that arrived without a newline", async () => {
    const { events } = await session(['{"n":1}\n{"n":2}']);
    expect(events).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("skips lines the parser rejects rather than failing the run", async () => {
    const { events } = await session(["not json\n", '{"n":7}\n']);
    expect(events).toEqual([{ n: 7 }]);
  });

  it("streams a step per event as it arrives", async () => {
    const steps: RuntimeStep[] = [];
    await session(['{"n":1}\n{"n":2}\n'], ctx({ onStep: (s) => steps.push(s) }));
    expect(steps.map((s) => s.description)).toEqual(["step 1", "step 2"]);
  });

  it("still collects events when the caller wants no live steps", async () => {
    const { events } = await session(['{"n":1}\n'], ctx());
    expect(events).toEqual([{ n: 1 }]);
  });

  // Renaming `pid` to `process_pid` is what lets the executor kill the
  // session later, so it has to survive the extraction.
  it("bridges onSpawn to the context's process_pid shape", async () => {
    const spawned: Array<{ process_pid: number; process_group_id: number }> = [];
    await session(["\n"], ctx({ onSpawn: (m) => spawned.push(m) }));
    expect(spawned).toEqual([{ process_pid: 4242, process_group_id: 4242 }]);
  });

  it("passes argv, cwd, env, stdin and the abort signal through", async () => {
    const controller = new AbortController();
    const cli = mockCli([]);
    await runNdjsonCliSession<Evt>({
      command: "faux",
      args: ["--json"],
      cwd: "/tmp/agent_x",
      env: { FOO: "bar" },
      stdin: "the intent",
      runtimeTag: "FauxRuntime",
      context: ctx({ abort_signal: controller.signal }),
      parseLine: () => null,
      extractSteps: () => [],
    });
    expect(cli.options()).toMatchObject({
      command: "faux",
      args: ["--json"],
      cwd: "/tmp/agent_x",
      env: { FOO: "bar" },
      stdin: "the intent",
      abortSignal: controller.signal,
    });
  });

  it("warns once with the runtime tag when stdout was capped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await session(['{"n":1}\n'], ctx(), { truncated: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[FauxRuntime]");
  });

  it("hands the raw CliProcessResult back for the caller to finalize", async () => {
    const { result } = await session([], ctx(), { exitCode: 3, aborted: true });
    expect(result).toMatchObject({ exitCode: 3, aborted: true, pid: 4242 });
  });
});
