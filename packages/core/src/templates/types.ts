/**
 * Agent templates — named, role-shaped agent configurations.
 *
 * The default agent record carries a free-form `runtime_config.system_prompt_addition`
 * and inherits the universal MCP server (`beevibe`). That's enough for ad-hoc
 * agents the operator hand-tunes, but it's not enough for agents that have a
 * defined job — a code reviewer, a research bee, a deploy guard. Those agents
 * need a stable role identity that survives across operators, plus extra MCP
 * servers wired in (e.g. the `adr` server for the CTO Bee).
 *
 * Templates resolve at spawn time:
 *   1. `composeSystemPromptAppend` pulls the template's prompt into the
 *      `extra` slot (alongside team routing) so it caches well.
 *   2. `buildMcpConfig` merges the template's `mcp_servers` into the
 *      workspace's mcp-config.json.
 *
 * Templates are NOT runtime-dynamic — they live as code in this package so
 * the prompt + tool surface is reviewable in git. Operators select a
 * template at agent-create time via `agent.agent_template`.
 */

/**
 * Static MCP server entry merged into the workspace's mcp-config.json.
 * Shape mirrors the existing `beevibe` entry written by `buildMcpConfig`.
 */
export type TemplateMcpServer =
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      type: "stdio";
      command: string;
      args?: readonly string[];
      env?: Record<string, string>;
    };

export interface AgentTemplate {
  /** Stable id used as `agent.agent_template`. kebab-case. */
  readonly name: string;
  /** Short label for UI. */
  readonly display_name: string;
  /** One-line summary. Surfaced in the agent picker. */
  readonly description: string;
  /**
   * Role-shaped system prompt addition. Injected via
   * `composeSystemPromptAppend`'s `extra` slot — same cache tier as team
   * routing. Keep it stable; per-session detail belongs in the intent.
   */
  readonly system_prompt: string;
  /**
   * Extra MCP servers merged into mcp-config.json. The universal `beevibe`
   * entry is always present and cannot be overridden here.
   */
  readonly mcp_servers?: Record<string, TemplateMcpServer>;
  /**
   * Default hierarchy level when creating an agent from this template.
   * The template can be applied to an existing agent of a different
   * level too — this is just the default suggestion in the UI.
   */
  readonly default_hierarchy_level?: "ic" | "team" | "org";
}
