import { describe, expect, it } from "vitest";
import { processResponse } from "./directives.js";

describe("processResponse — view_refs", () => {
  it("collects entity ids inline in the visible text", () => {
    const r = processResponse("see task_abc123def456 and agent_xyz123abc456");
    expect(r.view_refs).toEqual(["task_abc123def456", "agent_xyz123abc456"]);
  });

  it("dedupes repeated ids", () => {
    const r = processResponse("task_abc123def456 again task_abc123def456");
    expect(r.view_refs).toEqual(["task_abc123def456"]);
  });

  it("does not match malformed ids (wrong length, wrong prefix)", () => {
    const r = processResponse("task_short agent_TOOLONGTOOLONG12 unknown_abc123def456");
    expect(r.view_refs).toEqual([]);
  });
});

describe("processResponse — open_view path allow-list", () => {
  it("accepts an allow-listed path", () => {
    const r = processResponse(`<open_view path="/tasks/task_abc123def456" />`);
    expect(r.open_view).toEqual({ path: "/tasks/task_abc123def456" });
  });

  it("accepts a bare allow-listed path with an exact match", () => {
    const r = processResponse(`<open_view path="/mesh" />`);
    expect(r.open_view).toEqual({ path: "/mesh" });
  });

  it("captures an optional label attribute", () => {
    const r = processResponse(`<open_view path="/agents" label="See team" />`);
    expect(r.open_view).toEqual({ path: "/agents", label: "See team" });
  });

  it("rejects an off-list path", () => {
    const r = processResponse(`<open_view path="/admin/users" />`);
    expect(r.open_view).toBeUndefined();
  });

  it("rejects an external URL", () => {
    const r = processResponse(`<open_view path="https://attacker.example/x" />`);
    expect(r.open_view).toBeUndefined();
  });

  it("rejects a protocol-relative URL", () => {
    const r = processResponse(`<open_view path="//attacker.example/x" />`);
    expect(r.open_view).toBeUndefined();
  });

  it("rejects a path with traversal", () => {
    const r = processResponse(`<open_view path="/tasks/../../etc/passwd" />`);
    expect(r.open_view).toBeUndefined();
  });

  it("rejects when the path looks like a prefix-collision (e.g. /tasksomething)", () => {
    // /tasks must match exactly OR be followed by '/'. /taskstats is
    // not a known surface and shouldn't be accepted by a sloppy
    // startsWith check.
    const r = processResponse(`<open_view path="/taskstats" />`);
    expect(r.open_view).toBeUndefined();
  });

  it("strips the directive from visible text even when path is rejected", () => {
    const r = processResponse(
      `Some context text.\n<open_view path="/admin/users" />`,
    );
    expect(r.open_view).toBeUndefined();
    expect(r.visible).toBe("Some context text.");
  });
});

describe("processResponse — suggest_action chips", () => {
  it("parses self-closing label-only form", () => {
    const r = processResponse(`<suggest_action label="Approve" />`);
    expect(r.suggested_actions).toEqual([{ label: "Approve" }]);
  });

  it("parses self-closing label+prompt form", () => {
    const r = processResponse(
      `<suggest_action label="Approve" prompt="Approve as-is and ship it." />`,
    );
    expect(r.suggested_actions).toEqual([
      { label: "Approve", prompt: "Approve as-is and ship it." },
    ]);
  });

  it("parses paired-tag inline-text form", () => {
    const r = processResponse(`<suggest_action>Reject</suggest_action>`);
    expect(r.suggested_actions).toEqual([{ label: "Reject" }]);
  });

  it("parses paired-tag with label attribute (label visible, inline text becomes prompt)", () => {
    const r = processResponse(
      `<suggest_action label="Revise">Please tighten the intro.</suggest_action>`,
    );
    expect(r.suggested_actions).toEqual([
      { label: "Revise", prompt: "Please tighten the intro." },
    ]);
  });

  it("collects multiple chips", () => {
    const r = processResponse(
      `<suggest_action label="Approve" />\n<suggest_action label="Reject" />`,
    );
    expect(r.suggested_actions).toEqual([{ label: "Approve" }, { label: "Reject" }]);
  });

  it("dedupes chips with the same label", () => {
    const r = processResponse(
      `<suggest_action label="Approve" /><suggest_action label="Approve" />`,
    );
    expect(r.suggested_actions).toEqual([{ label: "Approve" }]);
  });

  it("ignores empty-label suggest_action tags", () => {
    const r = processResponse(`<suggest_action />`);
    expect(r.suggested_actions).toBeUndefined();
  });
});

describe("processResponse — visible text stripping", () => {
  it("strips both directive types from visible text", () => {
    const r = processResponse(
      `Here's the plan.\n<open_view path="/tasks" />\n<suggest_action label="OK" />`,
    );
    expect(r.visible).toBe("Here's the plan.");
  });

  it("returns the trimmed raw text when there are no directives", () => {
    const r = processResponse("  just a normal reply.  ");
    expect(r.visible).toBe("just a normal reply.");
  });
});
