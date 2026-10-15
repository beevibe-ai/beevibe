import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliProcessOptions, CliProcessResult } from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import * as spawnModule from "./claude-code/spawn.js";
import {
  cancelledResult,
  cliEnv,
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


function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    intent: "do a thing",
    workspace: { path: "/tmp/beevibe-runtime-common-ws" },
    system_prompt_append: "",
    ...overrides,
  };
}

describe("cliEnv", () => {
  // These cases are the only ones here that touch the real process env, so
  // they snapshot and restore the exact keys they set. Restoring rather than
  // deleting matters: OPENAI_API_KEY is a real key in CI, and the provider
  // suites read it.
  const TOUCHED = [
    "BEEVIBE_TEST_INHERITED",
    "SECRET_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
  ] as const;

  let prior: Partial<Record<(typeof TOUCHED)[number], string | undefined>> = {};

  beforeEach(() => {
    prior = {};
    for (const key of TOUCHED) prior[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of TOUCHED) {
      const was = prior[key];
      if (was === undefined) delete process.env[key];
      else process.env[key] = was;
    }
  });

  it("inherits the executor's own environment", () => {
    process.env.BEEVIBE_TEST_INHERITED = "yes";
    expect(cliEnv(ctx()).BEEVIBE_TEST_INHERITED).toBe("yes");
  });

  it("strips the vars the provider must not inherit", () => {
    process.env.SECRET_KEY = "leaked";
    expect(cliEnv(ctx(), ["SECRET_KEY"]).SECRET_KEY).toBeUndefined();
  });

  it("merges the per-session overrides", () => {
    expect(cliEnv(ctx({ env: { BEEVIBE_SESSION_ID: "ses_1" } })).BEEVIBE_SESSION_ID).toBe(
      "ses_1",
    );
  });

  // The strip happens before the merge, so a var the caller sets deliberately
  // survives even while the same name is stripped from the ambient env. Codex
  // relies on this ordering for BEEVIBE_AGENT_API_KEY-style handoffs.
  it("lets an explicit override win over a stripped var", () => {
    process.env.OPENAI_API_KEY = "ambient";
    const env = cliEnv(ctx({ env: { OPENAI_API_KEY: "deliberate" } }), ["OPENAI_API_KEY"]);
    expect(env.OPENAI_API_KEY).toBe("deliberate");
  });

  it("strips nothing when no vars are named", () => {
    process.env.OPENROUTER_API_KEY = "routing";
    expect(cliEnv(ctx()).OPENROUTER_API_KEY).toBe("routing");
  });
});

describe("runCliSession", () => {
  interface TestEvent {
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

  /** A spec that parses `{"n":N}` lines and reports the collected ns. */
  function spec(overrides: Partial<Parameters<typeof runCliSession<TestEvent>>[1]> = {}) {
    return {
      tag: "TestRuntime",
      command: "testcli",
      args: ["--json"],
      cwd: "/sandbox/agent_test",
      env: { PATH: "/usr/bin" },
      parseLine: (line: string): TestEvent | null => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return null;
        return JSON.parse(trimmed) as TestEvent;
      },
      extractSteps: (): RuntimeStep[] => [],
      parseResult: (events: TestEvent[], exitCode: number | null): RuntimeResult => ({
        status: exitCode === 0 ? "completed" : "failed",
        output: events.map((e) => e.n).join(","),
      }),
      ...overrides,
    };
  }

  beforeEach(() => {
    lastOptions = undefined;
    runCliSpy = vi.spyOn(spawnModule, "runCliProcess");
  });

  afterEach(() => {
    runCliSpy.mockRestore();
  });

  it("passes the spec through to the subprocess", async () => {
    mockRunCli(cliResult());
    await runCliSession(ctx(), spec({ stdin: "piped intent" }));
    expect(lastOptions).toMatchObject({
      command: "testcli",
      args: ["--json"],
      cwd: "/sandbox/agent_test",
      stdin: "piped intent",
    });
  });

  it("collects the parsed events and skips unparseable lines", async () => {
    mockRunCli(cliResult({ stdout: '{"n":1}\nnot json\n{"n":2}\n' }));
    const result = await runCliSession(ctx(), spec());
    expect(result.output).toBe("1,2");
  });

  // A stream can end without a trailing newline; the final partial line still
  // has to reach the parser or the last event is silently dropped.
  it("flushes a trailing line that has no newline", async () => {
    mockRunCli(cliResult({ stdout: '{"n":1}\n{"n":2}' }));
    const result = await runCliSession(ctx(), spec());
    expect(result.output).toBe("1,2");
  });

  it("fans each event out to onStep", async () => {
    mockRunCli(cliResult({ stdout: '{"n":7}\n' }));
    const steps: RuntimeStep[] = [];
    await runCliSession(
      ctx({ onStep: (s) => steps.push(s) }),
      spec({
        extractSteps: (e: TestEvent) => [{ kind: "text", text: String(e.n) } as RuntimeStep],
      }),
    );
    expect(steps).toEqual([{ kind: "text", text: "7" }]);
  });

  // The spawn callback renames pid -> process_pid on the way to the context;
  // each adapter used to do it by hand.
  it("adapts the spawn metadata to the context's shape", async () => {
    mockRunCli(cliResult({ pid: 321, process_group_id: 321 }));
    const spawns: Array<{ process_pid: number; process_group_id: number }> = [];
    await runCliSession(ctx({ onSpawn: (m) => spawns.push(m) }), spec());
    expect(spawns).toEqual([{ process_pid: 321, process_group_id: 321 }]);
  });

  it("reports an aborted run as cancelled, not as a result", async () => {
    mockRunCli(cliResult({ aborted: true, stdout: '{"n":1}\n' }));
    const result = await runCliSession(ctx(), spec());
    expect(result.status).toBe("cancelled");
    expect(result.output).toBe("Session cancelled.");
  });

  it("merges the process metadata into the parsed result", async () => {
    mockRunCli(cliResult({ exitCode: 3, stderr: "boom", pid: 77, process_group_id: 77 }));
    const result = await runCliSession(ctx(), spec());
    expect(result).toMatchObject({
      status: "failed",
      exit_code: 3,
      stderr: "boom",
      process_pid: 77,
    });
  });

  describe("onSettled", () => {
    it("runs before the result is parsed, so its value can be folded in", async () => {
      mockRunCli(cliResult());
      const order: string[] = [];
      await runCliSession(
        ctx(),
        spec({
          onSettled: () => order.push("settled"),
          parseResult: () => {
            order.push("parsed");
            return { status: "completed", output: "" } as RuntimeResult;
          },
        }),
      );
      expect(order).toEqual(["settled", "parsed"]);
    });

    // Codex's --output-last-message temp file is cleaned up here, so the hook
    // has to fire on the aborted path too or the file is left behind.
    it("runs on the aborted path as well", async () => {
      mockRunCli(cliResult({ aborted: true }));
      const onSettled = vi.fn();
      await runCliSession(ctx(), spec({ onSettled }));
      expect(onSettled).toHaveBeenCalledTimes(1);
    });
  });
});
