import { describe, expect, it } from "vitest";
import {
  OPENCODE_EVENT_TYPE,
  parseOpenCodeEventLine,
  extractOpenCodeStepEvents,
  parseOpenCodeEvents,
  type OpenCodeEvent,
} from "./stream-json.js";

/**
 * Fixtures match the wrapper shape emitted by opencode's run.ts `emit()`
 * helper: `{ type, timestamp, sessionID, ...payload }`. If opencode
 * changes the wire schema, these tests flip red first — that's the point.
 */

const SID = "ses_abc123";

const TEXT_PART_COMPLETED: OpenCodeEvent = {
  type: OPENCODE_EVENT_TYPE.Text,
  timestamp: 1,
  sessionID: SID,
  part: {
    id: "prt_t1",
    sessionID: SID,
    messageID: "msg_1",
    type: "text",
    text: "Here is the result.",
    time: { start: 0, end: 1 },
  },
};

const TOOL_USE_RUNNING: OpenCodeEvent = {
  type: OPENCODE_EVENT_TYPE.ToolUse,
  timestamp: 2,
  sessionID: SID,
  part: {
    id: "prt_tool_1",
    sessionID: SID,
    messageID: "msg_1",
    type: "tool",
    tool: "read",
    state: { status: "running", input: { file_path: "/src/x.ts" } },
  },
};

const TOOL_USE_COMPLETED: OpenCodeEvent = {
  type: OPENCODE_EVENT_TYPE.ToolUse,
  timestamp: 3,
  sessionID: SID,
  part: {
    id: "prt_tool_1",
    sessionID: SID,
    messageID: "msg_1",
    type: "tool",
    tool: "read",
    state: {
      status: "completed",
      input: { file_path: "/src/x.ts" },
      output: "file contents here",
    },
  },
};

const STEP_FINISH: OpenCodeEvent = {
  type: OPENCODE_EVENT_TYPE.StepFinish,
  timestamp: 4,
  sessionID: SID,
  part: {
    id: "prt_step_1",
    sessionID: SID,
    messageID: "msg_1",
    type: "step-finish",
    cost: 0.0042,
    tokens: {
      total: 200,
      input: 150,
      output: 40,
      reasoning: 10,
      cache: { read: 100, write: 20 },
    },
  },
};

describe("parseOpenCodeEventLine", () => {
  it("parses valid NDJSON wrapper events", () => {
    const evt = parseOpenCodeEventLine(JSON.stringify(TEXT_PART_COMPLETED));
    expect(evt).toEqual(TEXT_PART_COMPLETED);
  });

  it("returns null for empty / non-JSON lines", () => {
    expect(parseOpenCodeEventLine("")).toBeNull();
    expect(parseOpenCodeEventLine("   ")).toBeNull();
    expect(parseOpenCodeEventLine("WARN provider rate limited")).toBeNull();
  });
});

describe("extractOpenCodeStepEvents", () => {
  it("emits an agent step on text events with part.text", () => {
    const steps = extractOpenCodeStepEvents(TEXT_PART_COMPLETED);
    expect(steps).toEqual([
      expect.objectContaining({ kind: "agent", description: "Here is the result." }),
    ]);
  });

  it("emits tool_call while running, tool_result on completed", () => {
    expect(extractOpenCodeStepEvents(TOOL_USE_RUNNING)).toEqual([
      expect.objectContaining({ kind: "tool_call", tool: "read", description: "/src/x.ts" }),
    ]);
    expect(extractOpenCodeStepEvents(TOOL_USE_COMPLETED)).toEqual([
      expect.objectContaining({ kind: "tool_result", tool: "read" }),
    ]);
  });

  it("emits tool_result on tool error too — terminal state regardless of success", () => {
    const errorEvent: OpenCodeEvent = {
      ...TOOL_USE_COMPLETED,
      part: {
        ...TOOL_USE_COMPLETED.part!,
        state: { status: "error", input: { file_path: "/missing" }, error: "ENOENT" },
      },
    };
    expect(extractOpenCodeStepEvents(errorEvent)).toEqual([
      expect.objectContaining({ kind: "tool_result", tool: "read" }),
    ]);
  });

  it("skips step_start / step_finish / reasoning — no transcript noise", () => {
    expect(
      extractOpenCodeStepEvents({
        type: OPENCODE_EVENT_TYPE.StepStart,
        sessionID: SID,
        part: { id: "p", sessionID: SID, messageID: "m", type: "step-start" },
      }),
    ).toEqual([]);
    expect(extractOpenCodeStepEvents(STEP_FINISH)).toEqual([]);
    expect(
      extractOpenCodeStepEvents({
        type: OPENCODE_EVENT_TYPE.Reasoning,
        sessionID: SID,
        part: { id: "p", sessionID: SID, messageID: "m", type: "reasoning", text: "thinking" },
      }),
    ).toEqual([]);
  });
});

describe("parseOpenCodeEvents", () => {
  it("returns success with concatenated assistant text + summed per-step usage", () => {
    const events: OpenCodeEvent[] = [
      TOOL_USE_RUNNING,
      TOOL_USE_COMPLETED,
      TEXT_PART_COMPLETED,
      STEP_FINISH,
    ];
    const result = parseOpenCodeEvents(events, 0);
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Here is the result.");
    expect(result.cli_session_id).toBe(SID);
    expect(result.usage).toEqual({
      input_tokens: 150,
      // output is regular + reasoning summed so the cross-runtime total lines up
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 100,
      cost_usd: 0.0042,
    });
  });

  it("sums usage across multiple step_finish events (no terminal rollup exists)", () => {
    // Integer cost so we don't trip floating-point summation noise — the
    // sum-correctness assertion stands on its own.
    const second: OpenCodeEvent = {
      ...STEP_FINISH,
      part: {
        ...STEP_FINISH.part!,
        cost: 1,
        tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 30, write: 5 } },
      },
    };
    const first: OpenCodeEvent = {
      ...STEP_FINISH,
      part: { ...STEP_FINISH.part!, cost: 2 },
    };
    const result = parseOpenCodeEvents([first, second], 0);
    expect(result.usage).toEqual({
      input_tokens: 200,
      // (40 + 10 reasoning) + (10 + 0 reasoning) = 60; we sum reasoning
      // into output to keep cross-runtime totals comparable.
      output_tokens: 60,
      cache_creation_input_tokens: 25,
      cache_read_input_tokens: 130,
      cost_usd: 3,
    });
  });

  it("returns no usage when no step_finish event was emitted", () => {
    const result = parseOpenCodeEvents([TEXT_PART_COMPLETED], 0);
    expect(result.usage).toBeUndefined();
  });

  it("maps non-zero exit code to failed and prefers error event message", () => {
    const events: OpenCodeEvent[] = [
      TEXT_PART_COMPLETED,
      { type: OPENCODE_EVENT_TYPE.Error, sessionID: SID, error: { message: "provider auth missing" } },
    ];
    const result = parseOpenCodeEvents(events, 1);
    expect(result.status).toBe("failed");
    expect(result.output).toBe("provider auth missing");
  });

  it("falls back to bareCliExitMessage on failure with no error event — chat route can then swap", () => {
    const result = parseOpenCodeEvents([], 1);
    expect(result.output).toBe("CLI exited with code 1");
  });

  it("captures sessionID from any event (every event has it via emit()'s spread)", () => {
    const result = parseOpenCodeEvents([STEP_FINISH], 0);
    expect(result.cli_session_id).toBe(SID);
  });

  it("builds a transcript with [assistant] + [tool_call] + [tool_result from X] entries", () => {
    const events: OpenCodeEvent[] = [TOOL_USE_RUNNING, TOOL_USE_COMPLETED, TEXT_PART_COMPLETED];
    const result = parseOpenCodeEvents(events, 0);
    expect(result.transcript).toContain("[tool_call] read");
    expect(result.transcript).toContain("[tool_result from read] file contents here");
    expect(result.transcript).toContain("[assistant] Here is the result.");
  });
});
