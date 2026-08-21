import type { HierarchyLevel, SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  SessionSearchService,
} from "@beevibe/core/services/session-search";
import { errorMessage, SESSION_TYPES, SESSION_STATUSES } from "@beevibe/core";
import { toolError } from "./errors.js";
import { nonEmptyString, optionalNumber } from "./input.js";
import type { AgentTool } from "./types.js";

/**
 * session_search — Layer-3 memory: search past conversations via FTS,
 * scroll inside one, read a whole conversation, or browse recent activity.
 *
 * The tool description below is the agent-facing contract. It is the
 * heavy lifter — Hermes's design teaches that prompt-cache-friendly
 * stable system prompts plus a thick tool description outperform a
 * shorter description + more system-prompt guidance. See
 * /Users/danielzzzz/Projects/hermes-agent/tools/session_search_tool.py
 * for the reference shape.
 */

export interface SessionSearchToolContext {
  /** Caller's agent_id; drives tier-based scope resolution. */
  agentId: string;
  hierarchyLevel: HierarchyLevel;
  /** Beevibe session id this tool call is being made from. */
  sessionId: string;
}

export interface SessionSearchToolServices {
  sessionSearch: SessionSearchService;
}

const DESCRIPTION = [
  "Search your past Beevibe sessions, or scroll inside one. Postgres FTS-backed",
  "retrieval over the conversation store. No LLM calls — every shape returns",
  "actual messages.",
  "",
  "FOUR CALLING SHAPES",
  "",
  "  1) DISCOVERY — pass `query`:",
  "     session_search(query=\"auth refactor\", limit=3)",
  "     Runs FTS over user intents AND assistant turns, dedupes hits by",
  "     conversation lineage, returns the top N sessions. Each result carries:",
  "       - session (id, type, status, agent_id, task_id, intent_preview, …)",
  "       - snippet: FTS-highlighted match excerpt",
  "       - bookend_start: first 3 user+assistant turns of the lineage (the goal)",
  "       - messages: ±5 messages around the FTS match, anchor flagged",
  "       - bookend_end: last 3 user+assistant turns of the lineage (the resolution)",
  "       - match_message_id, matched_role, messages_before, messages_after",
  "     Bookends + window let you reconstruct goal → match → resolution without",
  "     paying for the whole transcript.",
  "",
  "  2) SCROLL — pass `session_id` + `around_message_id`:",
  "     session_search(session_id=\"sess_…\", around_message_id=\"evt_…\", window=10)",
  "     Returns a window of ±window messages centered on the anchor. No FTS,",
  "     no bookends — just the slice. Use after a discovery call when you need",
  "     more context than the ±5 default. Window clamped to [1, 20] (default 5).",
  "       - To scroll FORWARD: pass messages[-1].id back as around_message_id.",
  "       - To scroll BACKWARD: pass messages[0].id back as around_message_id.",
  "       - Anchor messages also appear with anchor=true.",
  "       - User-turn anchors use the synthetic id format `intent:<session_id>`.",
  "",
  "  3) READ — pass `session_id` only:",
  "     session_search(session_id=\"sess_…\")",
  "     Dumps the whole conversation (for chats, every turn in the chain;",
  "     for tasks, the single session). Truncates head-20 + tail-10 when large.",
  "",
  "  4) BROWSE — no args:",
  "     session_search()",
  "     Returns recent sessions chronologically: titles, previews, timestamps.",
  "     Use when the user asks \"what was I working on\" with no specific topic.",
  "",
  "BEEVIBE-SPECIFIC FILTERS (any shape that accepts `filters`)",
  "",
  "  filters.session_type — task | chat | mesh_ask | mesh_negotiate | blocker |",
  "    run_repo. Narrow when the kind of work matters.",
  "  filters.status — succeeded | failed | cancelled | running. \"Find the",
  "    failed session about X\" is the killer use case here.",
  "  filters.agent_id — narrow within your tier scope. Team/org callers only.",
  "  filters.task_id — restrict to sessions tied to one task (task + blocker +",
  "    revisions).",
  "  filters.since / filters.until — ISO timestamps for time-range queries.",
  "",
  "FTS SYNTAX (Google-style; powered by websearch_to_tsquery)",
  "",
  "  Default AND across words. Use OR explicitly (`alpha OR beta`), quoted",
  "  phrases (`\"docker networking\"`), or NOT (`-` prefix, e.g. `python -java`).",
  "",
  "WHEN TO USE",
  "",
  "  Reach for this BEFORE search_context, find_repo, or web search when the",
  "  user references past conversation: \"what did we do about X\", \"where did",
  "  we leave Y\", \"find the session where Z\". search_context is for archival",
  "  facts you already deemed worth saving; session_search is for what was",
  "  actually said when. Different layers.",
  "",
  "  Scope is auto-resolved from your tier (ic = own; team = own + subordinates;",
  "  org = own + all descendants). Your own active conversation is excluded so",
  "  you never re-discover messages already in your context.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Discovery shape only. Keywords or phrases to find in past sessions. " +
        "Omit to browse recent sessions. Ignored when session_id + around_message_id are set.",
    },
    limit: {
      type: "integer",
      description:
        "Discovery / browse. Max sessions to return. Discovery: default 3, max 10. " +
        "Browse: default 5, max 10. Bump when the topic likely spans several sessions.",
    },
    sort: {
      type: "string",
      enum: ["newest", "oldest"],
      description:
        "Discovery only. Temporal bias on top of FTS rank. Omit for relevance-only " +
        "(suitable for exploratory recall). Set 'newest' for \"where did we leave X\", " +
        "'oldest' for \"how did X start\". Ignored in scroll/read/browse.",
    },
    session_id: {
      type: "string",
      description:
        "Scroll/read shape. Use the session_id from a prior discovery hit or browse " +
        "row. Pair with around_message_id for scroll; pass alone to read the whole " +
        "conversation (the lineage, for chats).",
    },
    around_message_id: {
      type: "string",
      description:
        "Scroll shape. Message id to center the window on. From a discovery hit use " +
        "match_message_id, or any id seen in a prior window. For user-turn anchors, " +
        "the id is `intent:<session_id>`.",
    },
    window: {
      type: "integer",
      description:
        "Scroll only. Messages on each side of the anchor (anchor itself always " +
        "included). Clamped to [1, 20]. Default 5.",
    },
    filters: {
      type: "object",
      description: "Optional filters; see tool description for full semantics.",
      properties: {
        session_type: {
          type: "string",
          enum: [...SESSION_TYPES],
          description: "Restrict to one session type.",
        },
        status: {
          type: "string",
          enum: [...SESSION_STATUSES],
          description:
            "Restrict to one status. `failed` to surface past mistakes; " +
            "`succeeded` to find prior wins.",
        },
        agent_id: {
          type: "string",
          description:
            "Narrow within your tier scope to one specific agent. Calls outside " +
            "scope are refused.",
        },
        task_id: {
          type: "string",
          description: "Restrict to one task (the task + its blocker + revisions).",
        },
        since: {
          type: "string",
          description: "ISO-8601 lower bound on created_at.",
        },
        until: {
          type: "string",
          description: "ISO-8601 upper bound on created_at.",
        },
      },
    },
  },
} as const;

/**
 * Map raw tool input to a typed SessionSearchRequest. Shape inference matches
 * the Hermes design: scroll wins when both session_id + around_message_id are
 * set; bare session_id means read; query means discover; nothing means browse.
 */
function inferRequest(input: Record<string, unknown>): SessionSearchRequest {
  const filters =
    typeof input.filters === "object" && input.filters !== null
      ? (input.filters as SessionSearchRequest extends { filters?: infer F } ? F : never)
      : undefined;

  const sessionId = nonEmptyString(input, "session_id", { trim: true }) ?? null;
  const anchor = nonEmptyString(input, "around_message_id", { trim: true }) ?? null;
  const query = nonEmptyString(input, "query", { trim: true }) ?? null;

  if (sessionId && anchor) {
    return {
      kind: "scroll",
      session_id: sessionId,
      around_message_id: anchor,
      window: optionalNumber(input, "window"),
    };
  }
  if (sessionId) {
    return { kind: "read", session_id: sessionId };
  }
  if (query) {
    return {
      kind: "discover",
      query,
      limit: optionalNumber(input, "limit"),
      sort:
        input.sort === "newest" || input.sort === "oldest"
          ? input.sort
          : undefined,
      filters,
    };
  }
  return {
    kind: "browse",
    limit: optionalNumber(input, "limit"),
    filters,
  };
}

export function createSessionSearchTool(
  ctx: SessionSearchToolContext,
  services: SessionSearchToolServices,
): AgentTool {
  return {
    name: "session_search",
    description: DESCRIPTION,
    schema: SCHEMA as unknown as Record<string, unknown>,
    handler: async (input) => {
      try {
        const req = inferRequest(input);
        const result = await services.sessionSearch.search(req, {
          callerAgentId: ctx.agentId,
          hierarchyLevel: ctx.hierarchyLevel,
          currentSessionId: ctx.sessionId,
        });
        if (result === null) {
          return toolError(
            "not_found_or_forbidden",
            "session_id is not in your scope, the anchor message id does not " +
              "exist, or the anchor lives in your active conversation.",
          );
        }
        return { content: result as unknown as Record<string, unknown> };
      } catch (err) {
        // Match by name as well as instanceof so cross-bundle imports
        // (e.g. an integration script consuming src/ while api consumes
        // dist/) still surface the structured error code.
        const isSessionSearchError =
          err instanceof SessionSearchError ||
          (err instanceof Error && err.name === "SessionSearchError");
        if (isSessionSearchError) {
          const e = err as SessionSearchError;
          return toolError(e.code, e.message);
        }
        return toolError("internal_error", errorMessage(err));
      }
    },
  };
}
