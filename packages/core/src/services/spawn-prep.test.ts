import { describe, expect, it } from "vitest";
import {
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
      appendChatDirectives: true,
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
      appendChatDirectives: true,
      extra: teamAgentRoutingDirective([]),
    });
    expect(out).not.toContain("team_agent_routing");
  });
});
