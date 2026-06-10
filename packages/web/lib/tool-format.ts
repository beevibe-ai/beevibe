import {
  Bot,
  BookOpenText,
  Brain,
  FileSearch,
  HandHelping,
  History,
  ListTree,
  Network,
  PenLine,
  Search,
  ShieldQuestion,
  Sparkles,
  Terminal,
  UserPlus,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export type ToolCategory =
  | "mesh"
  | "memory"
  | "team"
  | "task"
  | "fs"
  | "shell"
  | "search"
  | "other";

export interface ToolDisplay {
  /** Short verb for the bubble line, e.g. "asked Frontend specialist". */
  label: string;
  /** Detail line — file path, command preview, question text. May be empty. */
  detail: string;
  /** Visual category — drives icon + accent color. */
  category: ToolCategory;
  icon: LucideIcon;
}

const MCP_PREFIX_RE = /^mcp__[^_]+__/;
const TASK_ID_RE = /\btask_[A-Za-z0-9_-]+\b/g;

export function normalizeToolName(toolName: string | undefined): string {
  return (toolName ?? "").trim().replace(MCP_PREFIX_RE, "");
}

function cleanToolDetail(content: string): string {
  const detail = content
    .trim()
    .replace(/mcp__[^_]+__/g, "")
    .replace(/select:/gi, "selected ")
    .replace(TASK_ID_RE, "task")
    .replace(/,/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  if (detail.toLowerCase().startsWith("selected ")) return detail.replace(/_/g, " ");
  return detail;
}

function fallbackLabel(toolName: string): string {
  return toolName
    .replace(MCP_PREFIX_RE, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim() || "step";
}

/**
 * Detect which of the four session_search shapes a tool_call landed on
 * (discover / scroll / read / browse) and render a tailored verb-label.
 *
 * `content` is the args blob — JSON or a pre-stringified key=value
 * preview, depending on which side of the runtime trimmed it. The four
 * shapes are inferred from key presence the same way the service does
 * it server-side (see packages/api/src/tools/session-search.ts).
 */
function formatSessionSearch(content: string): ToolDisplay {
  const args = safeParseJson(content) ?? {};
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const sessionId = typeof args.session_id === "string" ? args.session_id : "";
  const anchorId =
    typeof args.around_message_id === "string" ? args.around_message_id : "";

  if (sessionId && anchorId) {
    return {
      label: "Scrolled back",
      detail: sessionIdPreview(sessionId),
      category: "memory",
      icon: History,
    };
  }
  if (sessionId) {
    return {
      label: "Re-read a past session",
      detail: sessionIdPreview(sessionId),
      category: "memory",
      icon: History,
    };
  }
  if (query) {
    return {
      label: "Recalled past conversation",
      detail: `"${query}"`,
      category: "memory",
      icon: History,
    };
  }
  return {
    label: "Browsed recent sessions",
    detail: "",
    category: "memory",
    icon: History,
  };
}

function safeParseJson(s: string): Record<string, unknown> | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const v = JSON.parse(trimmed);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sessionIdPreview(id: string): string {
  // Drop the type prefix (sess_…) and show ~6 chars so the row stays
  // scannable. Mirrors deriveShortId() on the server.
  return id.replace(/^[a-z]+_/, "").slice(0, 6);
}

/**
 * Map a streamed tool-call event to a chat-friendly display: an
 * imperative verb ("asked", "saved a memory", "Read"), the most
 * informative input as `detail`, and a category that picks an icon and
 * an accent color. Mesh / team / memory tools are highlighted because
 * those are the differentiating moments in the demo.
 *
 * The runtime emits `tool_name` + a `content` blob (already pre-trimmed
 * by stream-json's describeToolInput); we just polish the surface.
 */
export function formatTool(toolName: string | undefined, content: string): ToolDisplay {
  const rawName = (toolName ?? "").trim();
  const name = normalizeToolName(toolName);
  const detail = cleanToolDetail(content);

  if (rawName === "ToolSearch") {
    return { label: "Selected tools", detail, category: "other", icon: Wrench };
  }

  // ── Mesh: agent-to-agent collaboration (the "team" pitch moments) ──
  if (name === "ask") {
    return { label: "Asked another agent", detail, category: "mesh", icon: Network };
  }
  if (name === "respond_ask") {
    return { label: "Answered an ask", detail, category: "mesh", icon: HandHelping };
  }
  if (name === "negotiate" || name === "respond_negotiate") {
    return { label: "Negotiating with peer", detail, category: "mesh", icon: Network };
  }
  if (name === "report_blocker") {
    return { label: "Reported a blocker", detail, category: "mesh", icon: ShieldQuestion };
  }
  if (name === "escalate_to_humans") {
    return { label: "Escalated to humans", detail, category: "mesh", icon: ShieldQuestion };
  }
  if (name === "add_to_escalation") {
    return { label: "Added to escalation", detail, category: "mesh", icon: ShieldQuestion };
  }
  if (name === "revise_task") {
    return { label: "Revised a subordinate's task", detail, category: "mesh", icon: PenLine };
  }

  // ── Team management: spawning agents, minting tasks, surveying the org ──
  if (name === "create_subordinate_agent") {
    return { label: "Spawned a specialist", detail, category: "team", icon: UserPlus };
  }
  if (name === "create_task") {
    return { label: "Minted a task", detail, category: "team", icon: ListTree };
  }
  if (name === "find_subordinates" || name === "find_peers" || name === "find_up") {
    return { label: "Surveyed the team", detail, category: "team", icon: Bot };
  }
  if (name === "get_agent_profile") {
    return { label: "Read a peer's profile", detail, category: "team", icon: Bot };
  }
  if (name === "check_work_status" || name === "get_task" || name === "list_work_products") {
    return { label: "Checked work status", detail, category: "task", icon: ListTree };
  }
  if (name === "create_work_product" || name === "update_work_product") {
    return { label: "Filed a work product", detail, category: "task", icon: PenLine };
  }
  if (name === "update_progress") {
    return { label: "Updated progress", detail, category: "task", icon: PenLine };
  }

  // ── Memory: search + write to the agent's persistent store ──
  if (name === "search_context") {
    return { label: "Searched memory", detail, category: "memory", icon: Brain };
  }
  if (name === "save_memory") {
    return { label: "Saved a memory", detail, category: "memory", icon: Brain };
  }
  if (name === "update_core_memory") {
    return { label: "Updated core memory", detail, category: "memory", icon: Brain };
  }
  if (name === "session_search") {
    return formatSessionSearch(content);
  }

  // ── Native Claude Code tools ──────────────────────────────────────────
  if (name === "Read") return { label: "Read", detail, category: "fs", icon: BookOpenText };
  if (name === "Write" || name === "Edit") {
    return { label: name === "Write" ? "Wrote file" : "Edited file", detail, category: "fs", icon: PenLine };
  }
  if (name === "Bash") return { label: "Bash", detail, category: "shell", icon: Terminal };
  if (name === "Glob") return { label: "Globbed paths", detail, category: "search", icon: FileSearch };
  if (name === "Grep") return { label: "Grepped", detail, category: "search", icon: Search };
  if (name === "WebFetch" || name === "WebSearch") {
    return { label: name === "WebFetch" ? "Fetched URL" : "Web search", detail, category: "search", icon: Search };
  }

  // Unknown / future tool — fall back to verbatim name.
  return {
    label: fallbackLabel(name || rawName),
    detail,
    category: "other",
    icon: Wrench,
  };
}

/** Tailwind classes for the category accent — used for the icon dot color. */
export function categoryAccent(category: ToolCategory): string {
  switch (category) {
    case "mesh":
      return "text-hier-team bg-hier-team/15";
    case "team":
      return "text-hier-team bg-hier-team/10";
    case "memory":
      return "text-status-running bg-status-running/15";
    case "task":
      return "text-status-review bg-status-review/15";
    case "fs":
      return "text-foreground/80 bg-muted";
    case "shell":
      return "text-foreground/80 bg-muted";
    case "search":
      return "text-foreground/80 bg-muted";
    default:
      return "text-muted-foreground bg-muted";
  }
}

/** Re-export so the bubble can render an icon for a step with one import. */
export { type LucideIcon as ToolIcon } from "lucide-react";

const _SPARKLES = Sparkles; // keep tree-shaker honest if we add a default-icon fallback later
void _SPARKLES;
