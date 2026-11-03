import { describe, expect, it } from "vitest";
import { requireStringArgs } from "./input.js";

describe("requireStringArgs", () => {
  it("returns the read values when every key is present", () => {
    const args = requireStringArgs({ task_id: "t_1", title: "Ship it" }, [
      "task_id",
      "title",
    ]);
    expect(args.error).toBeUndefined();
    expect(args.values).toEqual({ task_id: "t_1", title: "Ship it" });
  });

  it("coerces a non-string argument the way String(x ?? '') did", () => {
    const args = requireStringArgs({ id: 42 }, ["id"]);
    expect(args.values).toEqual({ id: "42" });
  });

  it.each([
    ["absent", {}],
    ["null", { id: null }],
    ["undefined", { id: undefined }],
    ["empty string", { id: "" }],
  ])("rejects a %s argument", (_label, input) => {
    const args = requireStringArgs(input as Record<string, unknown>, ["id"]);
    expect(args.values).toBeUndefined();
    expect(args.error).toEqual({ content: { error: "id required" }, isError: true });
  });

  it("passes whitespace through by default and rejects it under trim", () => {
    expect(requireStringArgs({ name: "  " }, ["name"]).values).toEqual({ name: "  " });
    expect(requireStringArgs({ name: "  " }, ["name"], { trim: true }).error).toBeDefined();
    expect(requireStringArgs({ name: " x " }, ["name"], { trim: true }).values).toEqual({
      name: "x",
    });
  });

  /**
   * The messages are the wire contract the tool handlers already had —
   * agents read them out of the transcript. Pinned verbatim so the
   * derived wording can't drift away from what each call site used to
   * return by hand.
   */
  it.each([
    [["agent_id"], "agent_id required"],
    [["task_id"], "task_id required"],
    [["id"], "id required"],
    [["escalation_id"], "escalation_id required"],
    [["task_id", "title"], "task_id and title required"],
    [["intent", "agent_id"], "intent and agent_id required"],
    [["task_id", "feedback"], "task_id and feedback required"],
    [["target_agent_id", "question"], "target_agent_id and question required"],
    [["request_id", "answer"], "request_id and answer required"],
    [["peer_id", "proposal"], "peer_id and proposal required"],
    [["negotiation_id", "message"], "negotiation_id and message required"],
    [["task_id", "description"], "task_id and description required"],
    [["negotiation_id", "summary"], "negotiation_id and summary required"],
  ])("renders %j as %s", (keys, message) => {
    const args = requireStringArgs({}, keys as readonly string[]);
    expect(args.error?.content).toEqual({ error: message });
  });

  it("names every required key, not just the first one missing", () => {
    const args = requireStringArgs({ task_id: "t_1" }, ["task_id", "title"]);
    expect(args.error?.content).toEqual({ error: "task_id and title required" });
  });
});
