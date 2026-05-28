import { describe, expect, it } from "vitest";
import {
  BEEVIBE_LIFECYCLE_REMINDER_CHAT,
  BEEVIBE_LIFECYCLE_REMINDER_RESPOND,
  BEEVIBE_LIFECYCLE_REMINDER_TASK,
  CHAT_DIRECTIVES,
  composeSystemPromptAppend,
  teamAgentRoutingDirective,
} from "./spawn-prep.js";

describe("teamAgentRoutingDirective", () => {
  it("emits the three-lane rubric with no specialists (lane A still applies)", () => {
    const out = teamAgentRoutingDirective([]);
    expect(out).toContain("team_agent_routing");
    expect(out).toContain("TEAM AGENT");
    // All three lanes must be addressable in the empty-roster case too —
    // lane A (small/exploratory/coordination) doesn't require a roster.
    expect(out).toContain("A) **Handle it yourself**");
    expect(out).toContain("B) **Delegate to one specialist**");
    expect(out).toContain("C) **Propose spawning a specialist**");
    // Empty-roster framing should still mention portability of spawns,
    // so the agent recommends cross-project specialists, not project-bound.
    expect(out.toLowerCase()).toContain("portable");
  });

  it("includes each specialist name as a list item", () => {
    const out = teamAgentRoutingDirective(["frontend", "backend", "data"]);
    expect(out).toContain("- frontend");
    expect(out).toContain("- backend");
    expect(out).toContain("- data");
  });

  it("frames specialists as portable across projects, not project-bound", () => {
    // Cross-project specialty is load-bearing: spawned specialists serve
    // every repo this user touches, not just the current project.
    const out = teamAgentRoutingDirective(["frontend"]);
    expect(out).toContain("PORTABLE");
    expect(out.toLowerCase()).toContain("every project and repo");
  });

  it("carries a stop signal against absorbing substantial single-domain work", () => {
    const out = teamAgentRoutingDirective(["frontend"]);
    expect(out).toContain("Stop signal");
    expect(out.toLowerCase()).toContain("substantial single-domain deliverable");
  });

  it("warns against create_task on self (avoids parallel session for the same agent)", () => {
    const out = teamAgentRoutingDirective(["frontend"]);
    expect(out).toContain("Do NOT");
    expect(out).toMatch(/create_task on yourself/);
  });

  it("contains no chat-only UI grammar (suggest_action chips live in CHAT_DIRECTIVES)", () => {
    // team_agent_routing is universal across chat AND task sessions —
    // suggest_action is a chat-only display token and belongs in
    // CHAT_DIRECTIVES, not here.
    const out = teamAgentRoutingDirective(["frontend"]);
    expect(out).not.toContain("<suggest_action");
  });

  it("instructs the agent to check task state via MCP tools before stating progress", () => {
    // Failure mode this guards against: user (or the agent itself)
    // refers to a previously-delegated task, agent answers from chat
    // history or memory without re-checking, gets stale state
    // ("both still running" when one finished an hour ago). The rule
    // is firm: call check_work_status or get_task first, never infer.
    const out = teamAgentRoutingDirective(["frontend"]);
    expect(out).toContain("Tracking delegated work");
    expect(out).toContain("mcp__beevibe__check_work_status");
    expect(out).toContain("mcp__beevibe__get_task");
    expect(out.toLowerCase()).toContain("never infer");
  });

  it("requires verifying work products before re-dispatching delegated work", () => {
    // Failure mode: team agent re-dispatches a previously-delegated
    // task believing "they hadn't started" without checking the
    // subordinate's actual deliverables. Result: duplicate PRs /
    // documents / artifacts for the same task. The fix is mandatory
    // verification via list_work_products + get_work_product before
    // any create_task that re-does prior work.
    const out = teamAgentRoutingDirective(["frontend"]);
    expect(out).toContain("Verify before acting on delegated work");
    expect(out).toContain("mcp__beevibe__list_work_products");
    expect(out).toContain("mcp__beevibe__get_work_product");
    expect(out.toLowerCase()).toContain("requires evidence");
  });

  it("verification directive is generic across deliverable types (not engineering-only)", () => {
    // Earlier draft was scoped to `gh pr list` which only catches the
    // PR case. The current directive must enumerate the work-product
    // type space so document/analysis/design/artifact deliveries get
    // the same protection from duplicate re-dispatch.
    const out = teamAgentRoutingDirective(["frontend"]).toLowerCase();
    expect(out).not.toContain("gh pr list");
    for (const t of ["document", "analysis", "design", "artifact"]) {
      expect(out).toContain(t);
    }
  });
});

describe("composeSystemPromptAppend with extra", () => {
  it("orders blocks by stability: static cross-agent → static surface → roster-stable → per-agent → per-session", () => {
    const teamRouting = teamAgentRoutingDirective(["frontend", "backend"]);
    // Use distinctive markers so indexOf can't collide with the memory
    // reminder's prose mentions of "core_memory" / "persona".
    const out = composeSystemPromptAppend(
      "<agent_baseline_marker/>",
      "<briefing_marker/>",
      {
        sessionKind: "chat",
        extra: teamRouting,
      },
    );
    // Tier 1: static cross-agent constants lead.
    expect(out.indexOf("beevibe_lifecycle")).toBeLessThan(
      out.indexOf("beevibe_memory"),
    );
    // Tier 2 → Tier 3: memory reminder before surface-specific static.
    expect(out.indexOf("beevibe_memory")).toBeLessThan(
      out.indexOf("chat_directives"),
    );
    // Tier 3 → Tier 4: chat directives before the roster-stable team
    // routing block — adding a new specialist invalidates everything
    // after this point, so it sits below the fully-static blocks.
    expect(out.indexOf("chat_directives")).toBeLessThan(
      out.indexOf("team_agent_routing"),
    );
    // Tier 4 → Tier 5: team routing before per-agent baseline (operator
    // edits invalidate baseline + briefing; roster changes are rarer).
    expect(out.indexOf("team_agent_routing")).toBeLessThan(
      out.indexOf("agent_baseline_marker"),
    );
    // Tier 5 → Tier 6: per-agent baseline before per-session briefing.
    expect(out.indexOf("agent_baseline_marker")).toBeLessThan(
      out.indexOf("briefing_marker"),
    );
  });

  it("includes team-routing block even when specialists is empty", () => {
    const out = composeSystemPromptAppend(undefined, "<core_memory/>", {
      sessionKind: "chat",
      extra: teamAgentRoutingDirective([]),
    });
    expect(out).toContain("team_agent_routing");
  });
});

describe("composeSystemPromptAppend with sessionKind: 'human_mcp'", () => {
  // Human MCP sessions: human's local CLI consumes the team agent's
  // identity over MCP. Same prompt content as a team chat session —
  // minus the beevibe chat UI grammar (the local CLI can't render
  // suggest_action chips) and minus onboarding directives (not a
  // first-touch surface).

  it("uses the chat-variant lifecycle reminder (interactive, not task-tracked)", () => {
    const out = composeSystemPromptAppend(undefined, "<core_memory/>", {
      sessionKind: "human_mcp",
    });
    expect(out).toContain(BEEVIBE_LIFECYCLE_REMINDER_CHAT);
    expect(out).not.toContain(BEEVIBE_LIFECYCLE_REMINDER_TASK);
  });

  it("skips CHAT_DIRECTIVES (chat UI grammar is beevibe-surface-only)", () => {
    const out = composeSystemPromptAppend(undefined, "<core_memory/>", {
      sessionKind: "human_mcp",
      extra: teamAgentRoutingDirective(["frontend"]),
    });
    expect(out).not.toContain("chat_directives");
    expect(out).not.toContain("<suggest_action");
    expect(out).not.toContain("<open_view");
  });

  it("still threads team_agent_routing extra (universal directive)", () => {
    const out = composeSystemPromptAppend(undefined, "<core_memory/>", {
      sessionKind: "human_mcp",
      extra: teamAgentRoutingDirective(["frontend"]),
    });
    expect(out).toContain("team_agent_routing");
    expect(out).toContain("- frontend");
  });

  it("preserves stability ordering minus the chat_directives slot", () => {
    const teamRouting = teamAgentRoutingDirective(["frontend"]);
    const out = composeSystemPromptAppend(
      "<agent_baseline_marker/>",
      "<briefing_marker/>",
      { sessionKind: "human_mcp", extra: teamRouting },
    );
    expect(out.indexOf("beevibe_lifecycle")).toBeLessThan(
      out.indexOf("beevibe_memory"),
    );
    expect(out.indexOf("beevibe_memory")).toBeLessThan(
      out.indexOf("team_agent_routing"),
    );
    expect(out.indexOf("team_agent_routing")).toBeLessThan(
      out.indexOf("agent_baseline_marker"),
    );
    expect(out.indexOf("agent_baseline_marker")).toBeLessThan(
      out.indexOf("briefing_marker"),
    );
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

  it("uses the respond variant when sessionKind is 'respond'", () => {
    // Mesh responders (mesh_ask / mesh_negotiate / blocker) have no
    // own-task and must not be told "always call update_progress."
    // Pre-fix they fell through to the task reminder and clobbered
    // the caller's task state on exit.
    const out = composeSystemPromptAppend(undefined, "<core_memory/>", {
      sessionKind: "respond",
    });
    expect(out).toContain(BEEVIBE_LIFECYCLE_REMINDER_RESPOND);
    expect(out).not.toContain(BEEVIBE_LIFECYCLE_REMINDER_TASK);
    expect(out).not.toContain(BEEVIBE_LIFECYCLE_REMINDER_CHAT);
  });

  it("respond variant explicitly bans update_progress (the cross-task clobber)", () => {
    // Load-bearing: this is exactly the rule that prevents a parent
    // agent's blocker session from calling update_progress(child_task,
    // "done") and reverting the needs_revision state revise_task just
    // set. Removing this language re-opens the bug.
    expect(BEEVIBE_LIFECYCLE_REMINDER_RESPOND).toMatch(
      /DO NOT call mcp__beevibe__update_progress/,
    );
    expect(BEEVIBE_LIFECYCLE_REMINDER_RESPOND.toLowerCase()).toContain(
      "no task of your own",
    );
  });

  it("respond variant names the three mesh shapes + their terminal action", () => {
    // The agent needs to know which tool closes its session for each
    // intent shape — otherwise it falls back to inventing one (the
    // bug attractor). Each shape → exactly one terminal tool.
    expect(BEEVIBE_LIFECYCLE_REMINDER_RESPOND).toContain("mesh-ask");
    expect(BEEVIBE_LIFECYCLE_REMINDER_RESPOND).toContain("respond_ask");
    expect(BEEVIBE_LIFECYCLE_REMINDER_RESPOND).toContain("mesh-negotiate");
    expect(BEEVIBE_LIFECYCLE_REMINDER_RESPOND).toContain("respond_negotiate");
    expect(BEEVIBE_LIFECYCLE_REMINDER_RESPOND).toContain("mesh-blocker");
    expect(BEEVIBE_LIFECYCLE_REMINDER_RESPOND).toContain("revise_task");
    expect(BEEVIBE_LIFECYCLE_REMINDER_RESPOND).toContain("escalate_to_humans");
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

  it("chat variant does not duplicate routing guidance from team_agent_routing", () => {
    // The chat reminder used to carry a create_task / routing bullet
    // that overlapped with <team_agent_routing>. Routing is now the
    // sole responsibility of that block (universal across chat + task),
    // so the chat reminder shouldn't mention create_task at all.
    expect(BEEVIBE_LIFECYCLE_REMINDER_CHAT).not.toContain("create_task");
    expect(BEEVIBE_LIFECYCLE_REMINDER_CHAT).not.toContain("find_subordinates");
  });

  it("chat variant does NOT carry a find_repo bias bullet — UI Try buttons drive that flow now", () => {
    // Regression guard going the other direction: we used to nudge
    // the agent in-prompt to "call find_repo before scaffolding," but
    // agents drifted past it under context pressure. The capability
    // network now drives use_repo via UI buttons on <repo_card>, not
    // by asking the agent to remember. Keeping the bullet out keeps
    // the cache prefix lean.
    expect(BEEVIBE_LIFECYCLE_REMINDER_CHAT.toLowerCase()).not.toContain("before proposing custom scaffolding");
    expect(BEEVIBE_LIFECYCLE_REMINDER_CHAT).not.toContain("find_repo");
  });

  it("chat directives document the <repo_card> tag for find_repo results", () => {
    // Regression guard so future edits don't silently drop the
    // structured repo-list rendering convention.
    expect(CHAT_DIRECTIVES).toContain("<repo_card");
    expect(CHAT_DIRECTIVES).toContain("repo_url=");
    expect(CHAT_DIRECTIVES).toContain("stars=");
    expect(CHAT_DIRECTIVES).toContain("source=");
  });

  it("chat directives explicitly ban the 'prompt dismissed' hallucination phrases", () => {
    // The agent kept narrating "looks like the prompt got dismissed"
    // even after we added the first version of this rule. The blacklist
    // needs to be in-prompt so we can grep for it.
    expect(CHAT_DIRECTIVES).toContain("the prompt was dismissed");
    expect(CHAT_DIRECTIVES).toContain("the question prompt got dismissed");
    expect(CHAT_DIRECTIVES.toLowerCase()).toContain("propose a sensible default and let you redirect");
    expect(CHAT_DIRECTIVES.toUpperCase()).toContain("BANNED");
  });

  it("all variants share the outer <beevibe_lifecycle> tag so downstream parsing is stable", () => {
    // Anything parsing system-prompt sections by tag (telemetry,
    // future skill discovery, etc.) shouldn't have to branch on
    // variant — only the body changes.
    for (const variant of [
      BEEVIBE_LIFECYCLE_REMINDER_TASK,
      BEEVIBE_LIFECYCLE_REMINDER_CHAT,
      BEEVIBE_LIFECYCLE_REMINDER_RESPOND,
    ]) {
      expect(variant.startsWith("<beevibe_lifecycle>")).toBe(true);
      expect(variant.trimEnd().endsWith("</beevibe_lifecycle>")).toBe(true);
    }
  });
});
