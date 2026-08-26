import { describe, expect, it } from "vitest";
import { requireStringArgs } from "./args.js";

describe("requireStringArgs", () => {
  it("returns the coerced values when every argument is present", () => {
    const args = requireStringArgs({ task_id: "t_1", title: "Ship it" }, [
      "task_id",
      "title",
    ]);
    expect(args.ok).toBe(true);
    if (!args.ok) return;
    expect(args.values).toEqual({ task_id: "t_1", title: "Ship it" });
  });

  it("rejects a missing argument with the message already on the wire", () => {
    const args = requireStringArgs({}, ["agent_id"]);
    expect(args.ok).toBe(false);
    if (args.ok) return;
    expect(args.result).toEqual({
      content: { error: "agent_id required" },
      isError: true,
    });
  });

  it("names every required argument, not just the missing one", () => {
    // The message is what the calling agent sees when its call bounces;
    // deriving it from the same list as the check is the point.
    const args = requireStringArgs({ task_id: "t_1" }, ["task_id", "title"]);
    expect(args.ok).toBe(false);
    if (args.ok) return;
    expect(args.result.content).toEqual({ error: "task_id and title required" });
  });

  it("treats an empty string as missing", () => {
    expect(requireStringArgs({ id: "" }, ["id"]).ok).toBe(false);
  });

  it("treats an explicit null as missing", () => {
    expect(requireStringArgs({ id: null }, ["id"]).ok).toBe(false);
  });

  it("accepts a whitespace-only value, leaving trimming to the caller", () => {
    // Same as the hand-written guards: `String("  ")` is truthy, and the
    // handlers that want a trim apply it after this check.
    const args = requireStringArgs({ id: "  " }, ["id"]);
    expect(args.ok).toBe(true);
  });

  it("coerces a non-string argument rather than rejecting it", () => {
    const args = requireStringArgs({ id: 42 }, ["id"]);
    expect(args.ok).toBe(true);
    if (!args.ok) return;
    expect(args.values.id).toBe("42");
  });

  it("rejects when a later argument is the missing one", () => {
    const args = requireStringArgs({ intent: "do it", agent_id: "" }, [
      "intent",
      "agent_id",
    ]);
    expect(args.ok).toBe(false);
    if (args.ok) return;
    expect(args.result.content).toEqual({ error: "intent and agent_id required" });
  });
});
