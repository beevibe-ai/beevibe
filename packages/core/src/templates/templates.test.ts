import { describe, expect, it } from "vitest";
import { composeSystemPromptAppend } from "../services/spawn-prep.js";
import { buildMcpConfig } from "../adapters/local-workspace/manager.js";
import {
  CTO_BEE_TEMPLATE,
  getAgentTemplate,
  isKnownAgentTemplate,
  listAgentTemplates,
  resolveTemplateToolFlags,
  UNIVERSAL_AGENT_TOOLS,
} from "./index.js";
import type { AgentTemplate } from "./types.js";

describe("agent template registry", () => {
  it("resolves cto-bee by name", () => {
    const t = getAgentTemplate("cto-bee");
    expect(t).not.toBeNull();
    expect(t?.name).toBe("cto-bee");
    expect(t?.display_name).toBe("AI CTO");
  });

  it("returns null for unknown templates so a stale agent_template row degrades gracefully", () => {
    expect(getAgentTemplate("ghost-template")).toBeNull();
    expect(getAgentTemplate(null)).toBeNull();
    expect(getAgentTemplate(undefined)).toBeNull();
    expect(getAgentTemplate("")).toBeNull();
  });

  it("isKnownAgentTemplate matches the registry", () => {
    expect(isKnownAgentTemplate("cto-bee")).toBe(true);
    expect(isKnownAgentTemplate("nope")).toBe(false);
  });

  it("lists every registered template", () => {
    const names = listAgentTemplates().map((t) => t.name);
    expect(names).toContain("cto-bee");
  });
});

describe("CTO_BEE_TEMPLATE", () => {
  it("wires the ADR MCP server", () => {
    expect(CTO_BEE_TEMPLATE.mcp_servers?.adr).toMatchObject({
      type: "stdio",
      command: "npx",
    });
  });

  it("declares team as the default hierarchy level so specialists can be routed to later", () => {
    expect(CTO_BEE_TEMPLATE.default_hierarchy_level).toBe("team");
  });

  it("system prompt names the three modes (discover, review, escalate)", () => {
    const p = CTO_BEE_TEMPLATE.system_prompt;
    expect(p).toContain("adr_principles");
    expect(p).toContain("adr_review");
    expect(p).toContain("adr_deep_research");
  });
});

describe("composeSystemPromptAppend with template", () => {
  it("injects templateSystemPrompt above the per-agent baseline so per-agent overrides still win", () => {
    const out = composeSystemPromptAppend("AGENT_BASELINE", "BRIEFING", {
      sessionKind: "chat",
      templateSystemPrompt: "TEMPLATE_ROLE_PROMPT",
    });
    const templateIdx = out.indexOf("TEMPLATE_ROLE_PROMPT");
    const baselineIdx = out.indexOf("AGENT_BASELINE");
    expect(templateIdx).toBeGreaterThan(-1);
    expect(baselineIdx).toBeGreaterThan(templateIdx);
  });

  it("is a no-op when templateSystemPrompt is omitted (existing agents unaffected)", () => {
    const without = composeSystemPromptAppend("BASELINE", "BRIEF", {
      sessionKind: "task",
    });
    expect(without).not.toContain("TEMPLATE_ROLE_PROMPT");
  });
});

describe("buildMcpConfig with extra servers", () => {
  it("merges extras alongside the universal beevibe server", () => {
    const config = JSON.parse(
      buildMcpConfig("bv_a_test", "http://localhost:3001", {
        adr: { type: "stdio", command: "npx", args: ["-y", "adr-mcp"] },
      }),
    );
    expect(Object.keys(config.mcpServers).sort()).toEqual(["adr", "beevibe"]);
    expect(config.mcpServers.beevibe.url).toBe("http://localhost:3001");
    expect(config.mcpServers.adr.command).toBe("npx");
  });

  it("refuses to let a template override the beevibe slot", () => {
    const config = JSON.parse(
      buildMcpConfig("bv_a_test", "http://localhost:3001", {
        beevibe: { type: "stdio", command: "rogue" },
      }),
    );
    expect(config.mcpServers.beevibe.type).toBe("http");
    expect(config.mcpServers.beevibe.url).toBe("http://localhost:3001");
  });

  it("matches the old single-arg shape when extras are omitted (backward-compat)", () => {
    const oldShape = buildMcpConfig("bv_a_x", "http://x");
    const newShapeNoExtras = buildMcpConfig("bv_a_x", "http://x", undefined);
    expect(oldShape).toBe(newShapeNoExtras);
  });
});

describe("resolveTemplateToolFlags", () => {
  function tpl(extras: Partial<AgentTemplate>): AgentTemplate {
    return {
      name: "test",
      display_name: "Test",
      description: "",
      system_prompt: "",
      ...extras,
    };
  }

  it("returns empty when no template", () => {
    expect(resolveTemplateToolFlags(null)).toEqual({});
    expect(resolveTemplateToolFlags(undefined)).toEqual({});
  });

  it("returns empty when template has no tool fields (existing templates unaffected)", () => {
    expect(resolveTemplateToolFlags(tpl({}))).toEqual({});
  });

  it("unions universal tools into allowed_tools so the platform survives narrowing", () => {
    const { allowed_tools, disallowed_tools } = resolveTemplateToolFlags(
      tpl({ allowed_tools: ["Read", "Grep"] }),
    );
    expect(disallowed_tools).toBeUndefined();
    expect(allowed_tools).toContain("Read");
    expect(allowed_tools).toContain("Grep");
    // Every universal tool must survive narrowing.
    for (const universal of UNIVERSAL_AGENT_TOOLS) {
      expect(allowed_tools).toContain(universal);
    }
  });

  it("deduplicates when allowed_tools overlaps universal tools", () => {
    const { allowed_tools } = resolveTemplateToolFlags(
      tpl({
        allowed_tools: ["Read", "mcp__beevibe__update_progress"],
      }),
    );
    const updateProgressCount = (allowed_tools ?? []).filter(
      (t) => t === "mcp__beevibe__update_progress",
    ).length;
    expect(updateProgressCount).toBe(1);
  });

  it("strips universal tools from disallowed_tools so the platform survives mistakes", () => {
    const { disallowed_tools } = resolveTemplateToolFlags(
      tpl({
        disallowed_tools: ["Bash", "mcp__beevibe__update_progress", "Write"],
      }),
    );
    expect(disallowed_tools).toContain("Bash");
    expect(disallowed_tools).toContain("Write");
    expect(disallowed_tools).not.toContain("mcp__beevibe__update_progress");
  });

  it("returns no disallowed_tools field when every entry is a universal tool (avoids passing an empty flag)", () => {
    const result = resolveTemplateToolFlags(
      tpl({ disallowed_tools: [...UNIVERSAL_AGENT_TOOLS] }),
    );
    expect(result.disallowed_tools).toBeUndefined();
  });

  it("supports allowed_tools and disallowed_tools coexisting", () => {
    const { allowed_tools, disallowed_tools } = resolveTemplateToolFlags(
      tpl({
        allowed_tools: ["Read"],
        disallowed_tools: ["Bash"],
      }),
    );
    expect(allowed_tools).toContain("Read");
    expect(disallowed_tools).toEqual(["Bash"]);
  });
});

describe("CTO_BEE_TEMPLATE tool flags", () => {
  it("does not restrict tools — the CTO Bee needs Read/Grep/Bash to review", () => {
    expect(CTO_BEE_TEMPLATE.allowed_tools).toBeUndefined();
    expect(CTO_BEE_TEMPLATE.disallowed_tools).toBeUndefined();
  });
});
