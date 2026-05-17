import { describe, expect, it } from "vitest";
import {
  CODEX_EVENT_TYPE,
  CODEX_ITEM_TYPE,
  parseCodexEventLine,
  extractCodexStepEvents,
  parseCodexEvents,
  type CodexEvent,
} from "./stream-json.js";

/**
 * Fixtures match the canonical schema in codex-rs/exec/src/exec_events.rs.
 * If codex changes its event shape, these tests are the first thing to flip
 * red — that's the point. Generic shape-guessing would silently keep
 * "passing" with garbage outputs.
 */

const THREAD_STARTED: CodexEvent = {
  type: CODEX_EVENT_TYPE.ThreadStarted,
  thread_id: "thread_abc123",
};

const TURN_COMPLETED: CodexEvent = {
  type: CODEX_EVENT_TYPE.TurnCompleted,
  usage: {
    input_tokens: 120,
    cached_input_tokens: 80,
    output_tokens: 40,
    reasoning_output_tokens: 10,
  },
};

const AGENT_MESSAGE_COMPLETED: CodexEvent = {
  type: CODEX_EVENT_TYPE.ItemCompleted,
  item: {
    id: "item_1",
    type: CODEX_ITEM_TYPE.AgentMessage,
    text: "Here is the fix.",
  },
};

describe("parseCodexEventLine", () => {
  it("parses valid NDJSON", () => {
    const evt = parseCodexEventLine(JSON.stringify(THREAD_STARTED));
    expect(evt).toEqual(THREAD_STARTED);
  });

  it("returns null for non-JSON lines (defensive — codex's stdout is supposed to be pure NDJSON)", () => {
    expect(parseCodexEventLine("WARN something")).toBeNull();
    expect(parseCodexEventLine("")).toBeNull();
    expect(parseCodexEventLine("   ")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseCodexEventLine("{not json")).toBeNull();
  });
});

describe("extractCodexStepEvents", () => {
  it("emits an agent step on item.completed for agent_message", () => {
    const steps = extractCodexStepEvents(AGENT_MESSAGE_COMPLETED);
    expect(steps).toEqual([
      expect.objectContaining({ kind: "agent", description: "Here is the fix." }),
    ]);
  });

  it("emits NO agent step on item.started (agent text only flows on completion)", () => {
    const steps = extractCodexStepEvents({
      type: CODEX_EVENT_TYPE.ItemStarted,
      item: { id: "item_1", type: CODEX_ITEM_TYPE.AgentMessage, text: "partial" },
    });
    expect(steps).toEqual([]);
  });

  it("emits tool_call on item.started + mcp_tool_call, tool_result on item.completed", () => {
    const started = extractCodexStepEvents({
      type: CODEX_EVENT_TYPE.ItemStarted,
      item: {
        id: "item_2",
        type: CODEX_ITEM_TYPE.McpToolCall,
        server: "beevibe",
        tool: "create_task",
        arguments: { title: "fix bug", description: "details" },
        status: "in_progress",
      },
    });
    expect(started).toEqual([
      expect.objectContaining({ kind: "tool_call", tool: "create_task" }),
    ]);

    const completed = extractCodexStepEvents({
      type: CODEX_EVENT_TYPE.ItemCompleted,
      item: {
        id: "item_2",
        type: CODEX_ITEM_TYPE.McpToolCall,
        server: "beevibe",
        tool: "create_task",
        arguments: { title: "fix bug" },
        result: { content: [{ type: "text", text: "ok" }] },
        status: "completed",
      },
    });
    expect(completed).toEqual([
      expect.objectContaining({ kind: "tool_result", tool: "create_task" }),
    ]);
  });

  it("emits a shell tool_call for command_execution items", () => {
    const steps = extractCodexStepEvents({
      type: CODEX_EVENT_TYPE.ItemStarted,
      item: {
        id: "item_3",
        type: CODEX_ITEM_TYPE.CommandExecution,
        command: "ls -la",
        status: "in_progress",
      },
    });
    expect(steps).toEqual([
      expect.objectContaining({ kind: "tool_call", tool: "shell", description: "ls -la" }),
    ]);
  });

  it("skips reasoning items so they don't bloat the transcript or dupe assistant text", () => {
    const steps = extractCodexStepEvents({
      type: CODEX_EVENT_TYPE.ItemCompleted,
      item: { id: "item_4", type: CODEX_ITEM_TYPE.Reasoning, text: "let me think" },
    });
    expect(steps).toEqual([]);
  });

  it("skips lifecycle events (thread.started / turn.*)", () => {
    expect(extractCodexStepEvents(THREAD_STARTED)).toEqual([]);
    expect(extractCodexStepEvents({ type: CODEX_EVENT_TYPE.TurnStarted })).toEqual([]);
    expect(extractCodexStepEvents(TURN_COMPLETED)).toEqual([]);
  });

  it("picks the most informative input field for mcp_tool_call descriptions", () => {
    const steps = extractCodexStepEvents({
      type: CODEX_EVENT_TYPE.ItemStarted,
      item: {
        id: "item_5",
        type: CODEX_ITEM_TYPE.McpToolCall,
        tool: "read_file",
        arguments: { file_path: "/repo/src/foo.ts", line: 10 },
        status: "in_progress",
      },
    });
    expect(steps[0]!.description).toBe("/repo/src/foo.ts");
  });
});

describe("parseCodexEvents", () => {
  it("returns success with last-message file content as output and pulls thread_id + usage", () => {
    const events = [THREAD_STARTED, AGENT_MESSAGE_COMPLETED, TURN_COMPLETED];
    const result = parseCodexEvents(events, 0, "Final answer from the last-message file.\n");
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Final answer from the last-message file.");
    expect(result.cli_session_id).toBe("thread_abc123");
    expect(result.usage).toEqual({
      input_tokens: 120,
      // output_tokens is regular + reasoning summed so cross-runtime totals line up
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 80,
    });
  });

  it("falls back to the agent_message text when the last-message file is empty", () => {
    const result = parseCodexEvents([THREAD_STARTED, AGENT_MESSAGE_COMPLETED], 0, "");
    expect(result.output).toBe("Here is the fix.");
  });

  it("maps non-zero exit code to failed, prefers turn.failed message over assistant text", () => {
    const events: CodexEvent[] = [
      THREAD_STARTED,
      AGENT_MESSAGE_COMPLETED,
      {
        type: CODEX_EVENT_TYPE.TurnFailed,
        error: { message: "model overloaded; retry shortly" },
      },
    ];
    const result = parseCodexEvents(events, 1, "");
    expect(result.status).toBe("failed");
    expect(result.output).toBe("model overloaded; retry shortly");
  });

  it("falls back to bareCliExitMessage when failure has no message — chat route's failureMessageFor can then swap it", () => {
    const result = parseCodexEvents([], 137, "");
    expect(result.status).toBe("failed");
    expect(result.output).toBe("CLI exited with code 137");
  });

  it("treats top-level error events as failure even when exit code is 0", () => {
    const events: CodexEvent[] = [
      THREAD_STARTED,
      { type: CODEX_EVENT_TYPE.Error, message: "rate limit hit" },
    ];
    const result = parseCodexEvents(events, 0, "");
    expect(result.status).toBe("failed");
    expect(result.output).toBe("rate limit hit");
  });

  it("builds a human-readable transcript with [assistant] + [tool_call] + [tool_result from X] entries", () => {
    const events: CodexEvent[] = [
      THREAD_STARTED,
      {
        type: CODEX_EVENT_TYPE.ItemCompleted,
        item: {
          id: "item_t1",
          type: CODEX_ITEM_TYPE.McpToolCall,
          tool: "create_task",
          arguments: { title: "fix" },
          result: { content: [{ type: "text", text: "task_abc" }] },
          status: "completed",
        },
      },
      AGENT_MESSAGE_COMPLETED,
    ];
    const result = parseCodexEvents(events, 0, "Here is the fix.");
    expect(result.transcript).toContain("[tool_call] create_task");
    expect(result.transcript).toContain("[tool_result from create_task] task_abc");
    expect(result.transcript).toContain("[assistant] Here is the fix.");
  });
});
