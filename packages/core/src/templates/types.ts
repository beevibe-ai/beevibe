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
  /**
   * Allowlist of tool names exposed to the agent. When set, ONLY these
   * tools (plus the {@link UNIVERSAL_AGENT_TOOLS} the platform needs
   * to function) are passed to Claude Code via `--allowedTools`.
   * Leave undefined for templates that want the full default tool set.
   *
   * Tool names match Claude Code's identifiers: built-ins like `Read`,
   * `Bash`, `Grep`, `Write`; MCP tools prefixed with
   * `mcp__<server>__<tool>` (e.g. `mcp__adr__adr_review`).
   */
  readonly allowed_tools?: readonly string[];
  /**
   * Denylist of tool names. Wins over `allowed_tools` on overlap.
   * Threaded through to Claude Code's `--disallowedTools`. Universal
   * tools cannot be denied — the platform short-circuits any attempt
   * to disable update_progress / archival_memory etc.
   *
   * Use this for "everything except X" templates. Use `allowed_tools`
   * for tight allowlists.
   */
  readonly disallowed_tools?: readonly string[];
}

/**
 * Tools the platform requires to function. These survive allowlist
 * narrowing and cannot be added to a template's `disallowed_tools` —
 * otherwise the agent can't report progress, persist memory, or hit
 * the platform's audit log, and the daemon's 2s retry loop will
 * thrash.
 *
 * Keep this list minimal: the lifecycle + memory primitives the chat
 * UI and the daemon assume exist.
 */
export const UNIVERSAL_AGENT_TOOLS: readonly string[] = Object.freeze([
  "mcp__beevibe__update_progress",
  "mcp__beevibe__archival_memory_insert",
  "mcp__beevibe__archival_memory_search",
  "mcp__beevibe__core_memory_replace",
  "mcp__beevibe__create_work_product",
  "mcp__beevibe__list_work_products",
  "mcp__beevibe__report_blocker",
]);

/**
 * Resolve the final CLI tool flags from a template. Returns the lists
 * that should be passed to Claude Code via `--allowedTools` and
 * `--disallowedTools`. Both can be undefined — in that case the
 * spawn pipeline omits the flags and Claude Code uses its default
 * (every tool allowed).
 *
 * Rules:
 *   1. If `allowed_tools` is set, union with `UNIVERSAL_AGENT_TOOLS`
 *      so the platform always survives. Pass that union via
 *      `--allowedTools`.
 *   2. If `disallowed_tools` is set, subtract `UNIVERSAL_AGENT_TOOLS`
 *      to keep the platform alive even if the template author
 *      accidentally lists one.
 *   3. Both can be set; allowlist + denylist coexist (Claude Code
 *      applies allow first, then deny).
 */
export function resolveTemplateToolFlags(
  template: AgentTemplate | null | undefined,
): { allowed_tools?: readonly string[]; disallowed_tools?: readonly string[] } {
  if (!template) return {};
  const result: {
    allowed_tools?: readonly string[];
    disallowed_tools?: readonly string[];
  } = {};
  if (template.allowed_tools && template.allowed_tools.length > 0) {
    result.allowed_tools = dedupe([
      ...UNIVERSAL_AGENT_TOOLS,
      ...template.allowed_tools,
    ]);
  }
  if (template.disallowed_tools && template.disallowed_tools.length > 0) {
    const universal = new Set(UNIVERSAL_AGENT_TOOLS);
    const safe = template.disallowed_tools.filter((t) => !universal.has(t));
    if (safe.length > 0) result.disallowed_tools = dedupe(safe);
  }
  return result;
}

function dedupe(arr: readonly string[]): readonly string[] {
  return Array.from(new Set(arr));
}
