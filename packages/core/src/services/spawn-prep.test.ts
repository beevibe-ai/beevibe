import { describe, expect, it } from "vitest";
import {
  BEEVIBE_LIFECYCLE_REMINDER_CHAT,
  BEEVIBE_LIFECYCLE_REMINDER_TASK,
  composeSystemPromptAppend,
  teamAgentRoutingDirective,
} from "./spawn-prep.js";

describe("teamAgentRoutingDirective", () => {
  it("returns empty string when there are no specialists", () => {
    expect(teamAgentRoutingDirective([])).toBe("");
  });

  it("includes each specialist name as a list item", () => {
    const out = teamAgentRoutingDirective(["frontend", "backend", "data"]);
    expect(out).toContain("- frontend");
    expect(out).toContain("- backend");
    expect(out).toContain("- data");
  });

  it("frames the agent as a coordinator and warns against absorbing work", () => {
    const out = teamAgentRoutingDirective(["frontend"]);
    expect(out).toContain("TEAM AGENT");
    expect(out).toContain("ROUTE");
    // The "delegate-don't-absorb" anti-pattern is named explicitly.
    expect(out.toLowerCase()).toContain("absorb");
  });

  it("provides suggest_action examples the chat UI knows how to render", () => {
    const out = teamAgentRoutingDirective(["frontend"]);
    expect(out).toContain("<suggest_action");
  });
});

describe("composeSystemPromptAppend with extra", () => {
  it("threads the team-routing directive at the tail (most-volatile slot)", () => {
    const teamRouting = teamAgentRoutingDirective(["frontend", "backend"]);
    const out = composeSystemPromptAppend(undefined, "<core_memory/>", {
      sessionKind: "chat",
      extra: teamRouting,
    });
    // Cache-friendly order: most-stable first. Lifecycle reminder leads.
    expect(out.indexOf("beevibe_lifecycle")).toBeLessThan(
      out.indexOf("core_memory"),
    );
    // CHAT_DIRECTIVES come before extra (extra is the most-volatile tail).
    expect(out.indexOf("chat_directives")).toBeLessThan(
      out.indexOf("team_agent_routing"),
    );
  });

  it("omits the team-routing block entirely when specialists is empty", () => {
    const out = composeSystemPromptAppend(undefined, "<core_memory/>", {
      sessionKind: "chat",
      extra: teamAgentRoutingDirective([]),
    });
    expect(out).not.toContain("team_agent_routing");
  });
});

describe("composeSystemPromptAppend lifecycle branching", () => {
  // Production bug pre-fix: chat sessions got the task-only lifecycle
  // reminder telling them to "call update_progress with task_id from
  // your intent's <task id>" — a directive they can't satisfy because
  // chat intents have no <task> block. The agent was told to do
  // something impossible. Branching the reminder by surface fixes it.

  it("uses the task variant by default (no sessionKind)", () => {
    const out = composeSystemPromptAppend(undefined, "<core_memory/>");
    expect(out).toContain(BEEVIBE_LIFECYCLE_REMINDER_TASK);
    expect(out).not.toContain(BEEVIBE_LIFECYCLE_REMINDER_CHAT);
  });

  it("uses the chat variant when sessionKind is 'chat'", () => {
    const out = composeSystemPromptAppend(undefined, "<core_memory/>", {
      sessionKind: "chat",
    });
    expect(out).toContain(BEEVIBE_LIFECYCLE_REMINDER_CHAT);
    expect(out).not.toContain(BEEVIBE_LIFECYCLE_REMINDER_TASK);
  });

  it("task variant carries the task-tracking directives", () => {
    // Load-bearing task directives the variant must keep.
    expect(BEEVIBE_LIFECYCLE_REMINDER_TASK).toContain("update_progress");
    expect(BEEVIBE_LIFECYCLE_REMINDER_TASK).toContain("work_product");
    expect(BEEVIBE_LIFECYCLE_REMINDER_TASK).toContain('<task id="..."/>');
  });

  it("chat variant omits the task-tracking imperative (negative mentions are OK)", () => {
    // The point of the chat variant: don't tell the agent it MUST
    // call APIs that need a task_id when the session has none.
    // Mentioning the same APIs negatively ("no update_progress to
    // call") is fine and helpful — the agent shouldn't have to infer
    // that task-only APIs don't apply.
    expect(BEEVIBE_LIFECYCLE_REMINDER_CHAT).not.toMatch(/MUST call .*update_progress/);
    expect(BEEVIBE_LIFECYCLE_REMINDER_CHAT).not.toMatch(/Before exiting.*update_progress/);
    // But it does explicitly disavow them so the agent knows not to try.
    // Regex tolerates line-wrapping between "NO" and the API name
    // (template-literal text wraps for source readability).
    expect(BEEVIBE_LIFECYCLE_REMINDER_CHAT).toMatch(/NO\s+update_progress/);
    expect(BEEVIBE_LIFECYCLE_REMINDER_CHAT).toMatch(/NO\s+work_product/);
  });

  it("chat variant still allows create_task for team/org tier", () => {
    // Discrete work surfaced mid-chat should still be promote-able to
    // a tracked task — keep the affordance explicit.
    expect(BEEVIBE_LIFECYCLE_REMINDER_CHAT).toContain("create_task");
  });

  it("both variants share the outer <beevibe_lifecycle> tag so downstream parsing is stable", () => {
    // Anything parsing system-prompt sections by tag (telemetry,
    // future skill discovery, etc.) shouldn't have to branch on
    // variant — only the body changes.
    expect(BEEVIBE_LIFECYCLE_REMINDER_TASK.startsWith("<beevibe_lifecycle>")).toBe(true);
    expect(BEEVIBE_LIFECYCLE_REMINDER_TASK.trimEnd().endsWith("</beevibe_lifecycle>")).toBe(true);
    expect(BEEVIBE_LIFECYCLE_REMINDER_CHAT.startsWith("<beevibe_lifecycle>")).toBe(true);
    expect(BEEVIBE_LIFECYCLE_REMINDER_CHAT.trimEnd().endsWith("</beevibe_lifecycle>")).toBe(true);
  });
});
