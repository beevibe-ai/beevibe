import type { HierarchyLevel } from "../domain/agent.js";
import type {
  SessionSearchRequest,
  SessionSearchResult,
} from "../domain/session-search.js";
import { lineageKey } from "../domain/session-search.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { SessionRepository } from "../ports/session-repo.js";
import type {
  SessionSearchRepository,
  SessionSearchScope,
} from "../ports/session-search-repo.js";

/**
 * Caller context for one session_search invocation. Mirrors the same
 * (agent_id, hierarchy_level, session_id) triple used by the MCP tool
 * layer for every other tool.
 */
export interface SessionSearchContext {
  /** The agent making the call. */
  callerAgentId: string;
  /** Tier — determines scope breadth (ic = own; team = +subords; org = +descendants). */
  hierarchyLevel: HierarchyLevel;
  /**
   * The session this call is being made from. Used to derive the
   * `exclude_lineage_keys` so the agent doesn't re-discover messages
   * already in its active context.
   */
  currentSessionId: string;
}

/**
 * Errors the service surfaces to the MCP tool layer. The tool wrapper
 * translates these into `{ isError: true, content: { error } }` shapes.
 */
export class SessionSearchError extends Error {
  constructor(
    public code: "forbidden_agent_filter" | "missing_query" | "missing_args",
    message: string,
  ) {
    super(message);
    this.name = "SessionSearchError";
  }
}

/**
 * Service layer: turns a caller-shaped request into a scoped repo call.
 *
 * Concretely:
 *   1. Resolves the caller's tier into a concrete agent_ids set, respecting
 *      Beevibe's owner boundary (subordinates always share the caller's
 *      owner via the agent table's invariants).
 *   2. Materialises `exclude_lineage_keys` from the current session's
 *      conversation_id so discovery and scroll don't re-surface in-context
 *      messages.
 *   3. Validates `filters.agent_id`, if set, sits inside the resolved scope.
 *      Anything outside is a 403-style refusal — no silent broadening.
 */
export class SessionSearchService {
  constructor(
    private repo: SessionSearchRepository,
    private agentRepo: AgentRepository,
    private sessionRepo: SessionRepository,
  ) {}

  async search(
    req: SessionSearchRequest,
    ctx: SessionSearchContext,
  ): Promise<SessionSearchResult | null> {
    this.validateRequest(req);
    const scope = await this.resolveScope(req, ctx);

    switch (req.kind) {
      case "discover":
        return this.repo.discover(req, scope);
      case "scroll":
        return this.repo.scroll(req, scope);
      case "read":
        return this.repo.read(req, scope);
      case "browse":
        return this.repo.browse(req, scope);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────

  private validateRequest(req: SessionSearchRequest): void {
    if (req.kind === "discover") {
      if (!req.query?.trim()) {
        throw new SessionSearchError(
          "missing_query",
          "query is required for discovery",
        );
      }
    }
    if (req.kind === "scroll") {
      if (!req.session_id || !req.around_message_id) {
        throw new SessionSearchError(
          "missing_args",
          "scroll requires both session_id and around_message_id",
        );
      }
    }
    if (req.kind === "read") {
      if (!req.session_id) {
        throw new SessionSearchError(
          "missing_args",
          "read requires session_id",
        );
      }
    }
  }

  private async resolveScope(
    req: SessionSearchRequest,
    ctx: SessionSearchContext,
  ): Promise<SessionSearchScope> {
    const scopeIds = await this.resolveScopeAgentIds(
      ctx.callerAgentId,
      ctx.hierarchyLevel,
    );
    const filters = "filters" in req ? req.filters : undefined;

    // Reject any agent_id filter outside the caller's reach.
    if (filters?.agent_id && !scopeIds.includes(filters.agent_id)) {
      throw new SessionSearchError(
        "forbidden_agent_filter",
        `agent_id ${filters.agent_id} is outside the caller's scope`,
      );
    }

    const excludeLineage = await this.resolveCurrentLineage(ctx.currentSessionId);
    return {
      agent_ids: scopeIds,
      exclude_lineage_keys: excludeLineage ? [excludeLineage] : [],
    };
  }

  private async resolveScopeAgentIds(
    callerAgentId: string,
    level: HierarchyLevel,
  ): Promise<string[]> {
    if (level === "ic") return [callerAgentId];
    if (level === "team") {
      const subs = await this.agentRepo.findSubordinates(callerAgentId);
      return [callerAgentId, ...subs.map((a) => a.id)];
    }
    // org
    const descendants = await this.agentRepo.findDescendantIds(callerAgentId);
    return [callerAgentId, ...descendants];
  }

  private async resolveCurrentLineage(
    sessionId: string,
  ): Promise<string | null> {
    const s = await this.sessionRepo.findById(sessionId);
    if (!s) return null;
    return lineageKey({
      id: s.id,
      conversation_id: s.conversation_id ?? null,
    });
  }
}
