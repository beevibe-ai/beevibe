import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessResult } from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  bareCliExitMessage,
  cancelledResult,
  createStdoutLineReader,
  createTranscript,
  finalizeCliResult,
  resolveCliOutput,
  streamCliEvents,
  transcriptSnippet,
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

// streamCliEvents owns process lifecycle, so these drive a real `node -e`
// subprocess rather than a mock — same reasoning as spawn.test.ts.

interface Evt {
  n: number;
}

function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    intent: "do the thing",
    workspace: { path: process.cwd() },
    system_prompt_append: "",
    ...overrides,
  };
}

function emitter(script: string) {
  return {
    tag: "TestRuntime",
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: {},
    parseLine: (line: string): Evt | null => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return null;
      return JSON.parse(trimmed) as Evt;
    },
    extractSteps: (e: Evt): RuntimeStep[] => [
      { kind: "agent" as const, description: `n=${e.n}`, timestamp: "T" },
    ],
  };
}

describe("streamCliEvents", () => {
  it.skipIf(process.platform === "win32")(
    "collects parsed events in arrival order and forwards steps",
    async () => {
      const steps: RuntimeStep[] = [];
      const { events, result } = await streamCliEvents(
        ctx({ onStep: (s) => steps.push(s) }),
        emitter('process.stdout.write(\'{"n":1}\\n{"n":2}\\n\')'),
      );
      expect(events).toEqual([{ n: 1 }, { n: 2 }]);
      expect(steps.map((s) => s.description)).toEqual(["n=1", "n=2"]);
      expect(result.exitCode).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "skips unparseable lines and keeps the trailing one without a newline",
    async () => {
      const { events } = await streamCliEvents(
        ctx(),
        emitter('process.stdout.write(\'noise\\n{"n":7}\')'),
      );
      expect(events).toEqual([{ n: 7 }]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "pipes `stdin` to the child",
    async () => {
      const { events } = await streamCliEvents(ctx(), {
        ...emitter(
          "let b='';process.stdin.on('data',c=>b+=c)" +
            ".on('end',()=>process.stdout.write(JSON.stringify({n:b.length})))",
        ),
        stdin: "abcd",
      });
      expect(events).toEqual([{ n: 4 }]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports the subprocess pid through onSpawn",
    async () => {
      const spawns: Array<{ process_pid: number }> = [];
      const { result } = await streamCliEvents(
        ctx({ onSpawn: (m) => spawns.push(m) }),
        emitter("process.stdout.write('')"),
      );
      expect(spawns).toHaveLength(1);
      expect(spawns[0]!.process_pid).toBe(result.pid);
    },
  );

  it.skipIf(process.platform === "win32")(
    "marks the result aborted when the context signal fires",
    async () => {
      const controller = new AbortController();
      const run = streamCliEvents(
        ctx({ abort_signal: controller.signal }),
        emitter("setTimeout(() => {}, 10_000)"),
      );
      setTimeout(() => controller.abort(), 50);
      const { result } = await run;
      expect(result.aborted).toBe(true);
    },
  );
});

describe("transcriptSnippet", () => {
  it("collapses newlines so one event stays one transcript line", () => {
    expect(transcriptSnippet("a\nb\nc")).toBe("a b c");
  });

  it("caps at 200 chars", () => {
    expect(transcriptSnippet("x".repeat(500))).toHaveLength(200);
  });
});

describe("createTranscript", () => {
  it("is undefined until something is recorded", () => {
    expect(createTranscript().build()).toBeUndefined();
  });

  it("writes the tagged line format the summarizers key off", () => {
    const t = createTranscript();
    t.assistant("hello");
    t.toolCall("Read");
    t.toolCall("shell", "ls -la");
    t.toolResult("Read", "file contents");
    t.toolResult("Read");
    t.toolResult(undefined, "orphaned");
    t.error("boom");
    expect(t.build()).toBe(
      "[assistant] hello\n" +
        "[tool_call] Read\n" +
        "[tool_call] shell ls -la\n" +
        "[tool_result from Read] file contents\n" +
        "[tool_result from Read]\n" +
        "[tool_result]\n" +
        "[error] boom\n",
    );
  });
});

describe("resolveCliOutput", () => {
  it("prefers the provider's failure message on the failed path", () => {
    expect(
      resolveCliOutput({
        failed: true,
        exitCode: 1,
        failureMessage: "rate limited",
        assistantText: "partial",
      }),
    ).toBe("rate limited");
  });

  it("falls back to the assistant text, then to the bare exit message", () => {
    expect(resolveCliOutput({ failed: true, exitCode: 2, assistantText: "partial" })).toBe(
      "partial",
    );
    expect(resolveCliOutput({ failed: true, exitCode: 2, assistantText: "" })).toBe(
      bareCliExitMessage(2),
    );
  });

  it("prefers the provider's canonical final text on the success path", () => {
    expect(
      resolveCliOutput({
        failed: false,
        exitCode: 0,
        assistantText: "streamed",
        preferredOutput: "from file",
      }),
    ).toBe("from file");
  });

  it("falls through an empty preferred output rather than returning it", () => {
    expect(
      resolveCliOutput({
        failed: false,
        exitCode: 0,
        assistantText: "streamed",
        preferredOutput: "",
      }),
    ).toBe("streamed");
  });

  it("ends at a neutral completion message when the run said nothing", () => {
    expect(resolveCliOutput({ failed: false, exitCode: 0, assistantText: "" })).toBe(
      "Session completed.",
    );
  });
});
