import { afterEach, describe, expect, it, vi } from "vitest";
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

/**
 * `runCliSession` owns the lifecycle every CLI runtime shares, and the ways
 * it can be wrong are silent rather than loud — a dropped trailing line, a
 * cancelled session reported as a failure, a scratch file left behind. The
 * three runtime suites exercise it through their own adapters; these cover
 * the invariants directly so a regression names the helper.
 */
describe("runCliSession", () => {
  interface Evt {
    n: number;
  }

  function context(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
    return {
      intent: "do the thing",
      system_prompt_append: "",
      workspace: { path: "/tmp/ws", agent_id: "agent_1" },
      ...overrides,
    } as RuntimeContext;
  }

  /** Stub `runCliProcess`, feeding `stdout` through the caller's `onLog`. */
  function stubSpawn(stdout: string, result: Partial<CliProcessResult> = {}) {
    return vi
      .spyOn(spawnModule, "runCliProcess")
      .mockImplementation(async (opts: CliProcessOptions) => {
        opts.onSpawn?.({ pid: 99, process_group_id: 99 });
        opts.onLog?.("stdout", stdout);
        return cliResult(result);
      });
  }

  const session = (opts: Partial<Parameters<typeof runCliSession<Evt>>[0]> = {}) =>
    runCliSession<Evt>({
      runtimeTag: "TestRuntime",
      command: "fake-cli",
      args: [],
      cwd: "/tmp/ws",
      context: context(),
      parseLine: (line) => (line.trim() ? (JSON.parse(line) as Evt) : null),
      extractSteps: () => [],
      parseResult: (events) => ({
        status: "completed",
        output: events.map((e) => e.n).join(","),
      }),
      ...opts,
    });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects every event from a stream that ends with a newline", async () => {
    stubSpawn('{"n":1}\n{"n":2}\n');
    expect((await session()).output).toBe("1,2");
  });

  it("flushes the trailing partial line before parsing", async () => {
    // No final \n — the last event only reaches the parser via flush().
    stubSpawn('{"n":1}\n{"n":2}');
    expect((await session()).output).toBe("1,2");
  });

  it("forwards each event's steps to context.onStep as they stream", async () => {
    stubSpawn('{"n":1}\n{"n":2}\n');
    const steps: RuntimeStep[] = [];
    await session({
      context: context({ onStep: (s) => steps.push(s) }),
      extractSteps: (e) => [
        { kind: "agent", description: `step ${e.n}`, timestamp: "2026-01-01T00:00:00.000Z" },
      ],
    });
    expect(steps.map((s) => s.description)).toEqual(["step 1", "step 2"]);
  });

  it("skips lines the parser rejects rather than failing the run", async () => {
    stubSpawn('{"n":1}\n\n{"n":2}\n');
    expect((await session()).output).toBe("1,2");
  });

  it("merges the settled process's metadata into the parsed result", async () => {
    stubSpawn('{"n":1}\n', { exitCode: 0, pid: 4242, process_group_id: 4242 });
    const out = await session();
    expect(out.process_pid).toBe(4242);
    expect(out.process_group_id).toBe(4242);
    expect(out.exit_code).toBe(0);
  });

  it("forwards the spawn metadata to context.onSpawn as soon as the pid exists", async () => {
    stubSpawn('{"n":1}\n');
    const onSpawn = vi.fn();
    await session({ context: context({ onSpawn }) });
    expect(onSpawn).toHaveBeenCalledWith({ process_pid: 99, process_group_id: 99 });
  });

  it("reports an aborted run as cancelled without parsing events", async () => {
    stubSpawn('{"n":1}\n', { aborted: true });
    const parseResult = vi.fn();
    const out = await session({ parseResult });
    expect(out.status).toBe("cancelled");
    expect(parseResult).not.toHaveBeenCalled();
  });

  it("runs cleanup after a normal run", async () => {
    stubSpawn('{"n":1}\n');
    const cleanup = vi.fn();
    await session({ cleanup });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs cleanup after an aborted run too", async () => {
    stubSpawn('{"n":1}\n', { aborted: true });
    const cleanup = vi.fn();
    await session({ cleanup });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("parses before cleanup, so a scratch file is still readable", async () => {
    stubSpawn('{"n":1}\n');
    const order: string[] = [];
    await session({
      parseResult: () => {
        order.push("parse");
        return { status: "completed", output: "" };
      },
      cleanup: () => order.push("cleanup"),
    });
    expect(order).toEqual(["parse", "cleanup"]);
  });

  it("passes stdin through when the prompt rides there instead of argv", async () => {
    const spy = stubSpawn('{"n":1}\n');
    await session({ stdin: "piped prompt" });
    expect(spy.mock.calls[0]![0].stdin).toBe("piped prompt");
  });

  it("warns once when stdout hit the capture cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubSpawn('{"n":1}\n', { truncated: true });
    await session();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("TestRuntime"));
  });
});
