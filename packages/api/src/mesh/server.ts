/**
 * MeshServer — in-process A2A broker for the mesh tool surface.
 *
 * Responsibilities:
 *   1. Capacity-gate target spawns (mesh_capacity_exceeded fail-fast).
 *   2. Spawn target agent CLI sessions via AgentSession.run + workspace
 *      provisioning. Fire-and-forget — the original tool call awaits the
 *      resolver, not the spawned promise.
 *   3. Resolver map for blocking ask + negotiate. Map keyed by request id
 *      with side-tag suffix:
 *        ask:        `${request_id}:asker`
 *        negotiate:  `${negotiation_id}:initiator|responder`
 *      Lost on api-server restart — documented limitation.
 *   4. B-resident negotiation: B is spawned ONCE on round 1 and stays
 *      alive across rounds. After round 1 BOTH sides use respond_negotiate.
 *   5. Sentinel-unblock when escalate_to_humans fires — releases the peer's
 *      pending respond_negotiate with an `escalated` sentinel so they can
 *      call add_to_escalation and exit.
 *
 * What it does NOT do:
 *   - Persist resolver state across restarts (M6 limitation).
 *   - Track ChainBudget (deferred to a separate issue).
 *   - Authenticate the tool caller (auth middleware does that upstream).
 *
 * Pattern lifted from intentcore mesh-server.ts:340-441 with adaptations:
 *   - WebSocket Chat Gateway stripped (A2 flag from M6 plan).
 *   - Spawning uses M3's AgentSession + LocalWorkspaceManager (per the
 *     "second composition root" plan call-out).
 *   - Negotiation round counts persisted to DB (negotiation_round table)
 *     vs in-memory only.
 */

import type {
  AgentRepository,
  RuntimeRegistry,
  SessionRepository,
  WorkspaceManager,
} from "@beevibe/core";
import {
  negotiationId as makeNegId,
  negotiationRoundId as makeRoundId,
  sessionId as makeSessionId,
} from "@beevibe/core";
import type {
  NegotiationRepository,
  NegotiationRoundRepository,
} from "@beevibe/core";
import {
  AgentSession,
  type AgentSessionDeps,
} from "@beevibe/core/services/agent-session";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import {
  type AskResponse,
  type EscalatedSentinel,
  type NegotiateResponse,
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "./types.js";

const DEFAULT_NEGOTIATE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ASK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_NEGOTIATION_ROUNDS = 5;
const DEFAULT_MAX_MESH_SESSIONS = 3;

/** Mesh session types that count toward the per-agent mesh cap. */
const MESH_SESSION_TYPES = ["mesh_ask", "mesh_negotiate", "blocker"] as const;

export interface MeshServerDeps {
  agentRepo: AgentRepository;
  sessionRepo: SessionRepository;
  negotiationRepo: NegotiationRepository;
  negotiationRoundRepo: NegotiationRoundRepository;
  workspaceManager: WorkspaceManager;
  runtimeRegistry: RuntimeRegistry;
  /** Per-agent MemoryAgent factory for spawned sessions. */
  makeMemoryAgent: (agentId: string) => MemoryAgent;
}

interface ResolverEntry<T> {
  resolve: (response: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type AskOrNegotiate = AskResponse | NegotiateResponse | EscalatedSentinel;

export class MeshServer {
  private readonly resolvers = new Map<string, ResolverEntry<AskOrNegotiate>>();

  constructor(private readonly deps: MeshServerDeps) {}

  // ── ASK ─────────────────────────────────────────────────────────────────

  /**
   * `ask(target_agent_id, question)` backend. Spawns target B's session,
   * waits for B's `respond_ask` to fire the resolver, returns the response.
   * One-shot — terminal on respond_ask.
   *
   * Throws MeshCapacityError if B is at mesh cap.
   */
  async sendAsk(
    requestId: string,
    fromAgentId: string,
    toAgentId: string,
    question: string,
  ): Promise<AskResponse> {
    await this.checkMeshCapacity(toAgentId);

    const intent =
      `<mesh-ask request_id="${escapeAttr(requestId)}" from="${escapeAttr(fromAgentId)}">\n` +
      `${question}\n` +
      `</mesh-ask>\n` +
      `<context type="ask_response">\n` +
      `Read the question, search relevant context if needed, and respond by calling respond_ask(request_id="${requestId}", answer="..."). The answer is delivered to the asker via that tool — replying in chat alone does NOT reach them. After respond_ask returns, exit.\n` +
      `</context>`;

    void this.spawnTargetSession({
      targetAgentId: toAgentId,
      type: "mesh_ask",
      intent,
    });

    return this.awaitResolver<AskResponse>(`${requestId}:asker`, DEFAULT_ASK_TIMEOUT_MS);
  }

  /**
   * `respond_ask` backend. Resolves the asker's blocked promise. Terminal —
   * no continuation. The B session typically exits after calling this.
   */
  respondAsk(requestId: string, response: AskResponse): void {
    this.fireResolver(`${requestId}:asker`, response);
  }

  // ── NEGOTIATE ───────────────────────────────────────────────────────────

  /**
   * `negotiate` backend. Round 1 only — kicks off the negotiation, spawns B,
   * registers the initiator's resolver, awaits B's first `respond_negotiate`.
   * Subsequent rounds: BOTH sides use `respondNegotiate`.
   *
   * Creates the `negotiation` row (status='active') stamped with the
   * initiator agent's max_negotiation_rounds. Inserts round 1 (decision=
   * 'propose'). Updates negotiation.counterparty_session_id is deferred —
   * AgentSession.run mints the session id internally. We don't read it
   * back here; it's stamped at sentinel-unblock time if needed via
   * `escalation.counterparty_session_id` (set by EscalationService).
   *
   * Wait — we DO need to know B's session id for the escalation row. Look
   * it up via session listing right before returning — or read the new
   * "spawnedSessionId" we capture from AgentSession's create-row callback.
   * Simpler: after sendNegotiate's spawn fires its onSessionCreated hook,
   * we update the negotiation row with counterparty_session_id.
   */
  async sendNegotiate(
    fromAgentId: string,
    toAgentId: string,
    proposal: string,
    options: { taskId?: string; initiatorSessionId: string },
  ): Promise<NegotiateResponse | EscalatedSentinel> {
    // M9.1: ICs are workers, not deciders. They don't have respond_negotiate
    // (M9.1 dropped it from buildIcMeshTools), so a negotiation against them
    // would hang forever. Reject fast with a clear error instead.
    const target = await this.deps.agentRepo.findById(toAgentId);
    if (!target) throw new Error(`target agent not found: ${toAgentId}`);
    if (target.hierarchy_level === "ic") {
      throw new CannotNegotiateWithIcError({ agentId: toAgentId });
    }

    await this.checkMeshCapacity(toAgentId);

    const initiator = await this.deps.agentRepo.findById(fromAgentId);
    if (!initiator) throw new Error(`initiator agent not found: ${fromAgentId}`);
    const maxRounds = initiator.max_negotiation_rounds ?? DEFAULT_MAX_NEGOTIATION_ROUNDS;

    // Pre-generate B's sid so AgentSession.run uses it (so the spawn's
    // session row matches the id we'll stamp on the negotiation row when
    // B first calls respond_negotiate). The negotiation row itself starts
    // with `counterparty_session_id IS NULL` — the FK only requires the
    // referenced session to exist when the column is set; we set it later,
    // after the spawn has created B's session row.
    const counterpartySid = makeSessionId();

    const neg = await this.deps.negotiationRepo.create({
      id: makeNegId(),
      initiator_agent_id: fromAgentId,
      initiator_session_id: options.initiatorSessionId,
      counterparty_agent_id: toAgentId,
      task_id: options.taskId,
      max_rounds: maxRounds,
    });

    // INSERT round 1 (initiator's proposal). sendNegotiate is the round-1
    // entry point only; bump rounds_completed in the same logical step so
    // respondNegotiate can compute nextRoundNumber correctly (otherwise
    // B's first respond_negotiate re-attempts round_number=1 and trips the
    // UNIQUE constraint on negotiation_round).
    await this.deps.negotiationRoundRepo.create({
      id: makeRoundId(),
      negotiation_id: neg.id,
      round_number: 1,
      from_agent_id: fromAgentId,
      decision: "propose",
      message: proposal,
    });
    await this.deps.negotiationRepo.update(neg.id, { rounds_completed: 1 });

    const intent =
      `<mesh-negotiate negotiation_id="${escapeAttr(neg.id)}" from="${escapeAttr(fromAgentId)}" round="1">\n` +
      `${proposal}\n` +
      `</mesh-negotiate>\n` +
      `<context type="negotiation_round">\n` +
      `Read the proposal, search relevant context if needed, and respond with respond_negotiate(negotiation_id="${neg.id}", decision, message). Decisions: counter (propose alternative), accept, reject.\n` +
      `</context>`;

    void this.spawnTargetSession({
      targetAgentId: toAgentId,
      type: "mesh_negotiate",
      intent,
      sessionId: counterpartySid,
    });

    return this.awaitResolver<NegotiateResponse | EscalatedSentinel>(
      `${neg.id}:initiator`,
      DEFAULT_NEGOTIATE_TIMEOUT_MS,
    );
  }

  /**
   * `respond_negotiate` backend. Used by BOTH sides after round 1.
   *
   * Resolves the side currently waiting (initiator or responder). If the
   * responding side issues `decision='counter'`, the server registers
   * THEIR resolver (opposite key) and blocks awaiting the peer's reply,
   * mirroring the old intentcore pattern (mesh-server.ts:391-421).
   *
   * Returns:
   *   - `null`              if decision was accept/reject (terminal)
   *   - NegotiateResponse   the peer's next round's response
   *   - EscalatedSentinel   if the peer (or anyone) escalated while waiting
   *
   * Throws MeshMaxRoundsError if the next round would exceed max_rounds —
   * the agent's CLI sees this error result and is prompted to call
   * escalate_to_humans instead.
   */
  async respondNegotiate(
    negotiationId: string,
    response: NegotiateResponse,
    responderSessionId: string,
  ): Promise<NegotiateResponse | EscalatedSentinel | null> {
    const neg = await this.deps.negotiationRepo.findById(negotiationId);
    if (!neg) {
      throw new Error(`negotiation ${negotiationId} not found`);
    }
    if (neg.status !== "active") {
      throw new Error(
        `negotiation ${negotiationId} is not active (status='${neg.status}')`,
      );
    }

    // First respond_negotiate from B → stamp B's session id on the negotiation
    // row. Idempotent: only fires when the field is NULL and the responder is
    // the negotiation's counterparty. Subsequent rounds (B counter → A reply
    // → B reply, etc.) are no-ops because the field is already set.
    if (
      !neg.counterparty_session_id &&
      response.from_agent_id === neg.counterparty_agent_id
    ) {
      await this.deps.negotiationRepo.update(negotiationId, {
        counterparty_session_id: responderSessionId,
      });
    }

    // The schema's `rounds_completed` column counts INSERTed rows (each
    // respond_negotiate adds one). But `max_rounds` semantically caps the
    // number of A↔B EXCHANGES — one full back-and-forth = one user-facing
    // "round". An exchange has two halves: A starts it, B completes it.
    //
    //   row 1: A propose      → exchange 1 in progress
    //   row 2: B respond      → exchange 1 complete   (B never hits cap)
    //   row 3: A counter      → exchange 2 starts    (A may hit cap here)
    //   row 4: B counter      → exchange 2 complete
    //   ...
    //
    // Cap check: would inserting THIS row start an exchange beyond the cap?
    const nextRoundNumber = neg.rounds_completed + 1;
    const wouldBeExchange = Math.ceil(nextRoundNumber / 2);
    if (wouldBeExchange > neg.max_rounds) {
      throw new MeshMaxRoundsError({
        negotiationId,
        rounds_completed: neg.rounds_completed,
        max_rounds: neg.max_rounds,
      });
    }

    // Persist this round.
    await this.deps.negotiationRoundRepo.create({
      id: makeRoundId(),
      negotiation_id: negotiationId,
      round_number: nextRoundNumber,
      from_agent_id: response.from_agent_id,
      decision: response.decision,
      message: response.message,
    });
    await this.deps.negotiationRepo.update(negotiationId, {
      rounds_completed: nextRoundNumber,
    });

    const initiatorKey = `${negotiationId}:initiator`;
    const responderKey = `${negotiationId}:responder`;

    // Identify which side is currently blocked and resolve them.
    const initiatorEntry = this.resolvers.get(initiatorKey);
    const responderEntry = this.resolvers.get(responderKey);

    if (initiatorEntry) {
      this.fireResolver(initiatorKey, response);
    } else if (responderEntry) {
      this.fireResolver(responderKey, response);
    }
    // If neither side is blocked: this is the very first respond_negotiate
    // (B replying to round 1's proposal); the initiator's resolver was set
    // by sendNegotiate. Nothing to do — fall through to the counter check.

    if (response.decision === "accept" || response.decision === "reject") {
      // Terminal — close out the negotiation.
      await this.deps.negotiationRepo.update(negotiationId, {
        status: response.decision === "accept" ? "accepted" : "rejected",
      });
      return null;
    }

    // decision === 'counter' — block the caller (the side that just
    // responded) waiting for the peer's reply. Register on the OPPOSITE
    // key from whichever was just resolved (or the initiator key if this
    // was B's first response to round 1).
    const myKey = initiatorEntry ? responderKey : initiatorKey;
    return this.awaitResolver<NegotiateResponse | EscalatedSentinel>(
      myKey,
      DEFAULT_NEGOTIATE_TIMEOUT_MS,
    );
  }

  /**
   * Sentinel-unblock the peer's blocked respond_negotiate when
   * escalate_to_humans fires. Resolves whichever side is currently
   * waiting with the escalated sentinel; the agent sees decision='escalated'
   * and is prompted to call add_to_escalation, then exit.
   *
   * Idempotent — if no resolver is registered (escalation came AFTER both
   * sides already exited), it's a no-op.
   */
  unblockOnEscalate(negotiationId: string, escalationId: string): void {
    const sentinel: EscalatedSentinel = {
      decision: "escalated",
      message:
        "Peer initiated escalation. Submit your perspective via " +
        `add_to_escalation(escalation_id="${escalationId}", proposals, open_questions), then exit.`,
      escalation_id: escalationId,
      negotiation_id: negotiationId,
    };
    const initiatorKey = `${negotiationId}:initiator`;
    const responderKey = `${negotiationId}:responder`;
    if (this.resolvers.has(initiatorKey)) {
      this.fireResolver(initiatorKey, sentinel);
    }
    if (this.resolvers.has(responderKey)) {
      this.fireResolver(responderKey, sentinel);
    }
  }

  // ── BLOCKER (fire-and-forget) ──────────────────────────────────────────

  /**
   * `report_blocker` backend. Spawns the parent agent's session with the
   * blocker context. Fire-and-forget — caller doesn't wait for parent's
   * response. Lower agent's task is marked blocked separately by the tool
   * handler via taskService.markBlocked.
   */
  reportBlocker(
    parentAgentId: string,
    fromAgentId: string,
    taskId: string,
    description: string,
  ): void {
    const intent =
      `<mesh-blocker from="${escapeAttr(fromAgentId)}" task_id="${escapeAttr(taskId)}">\n` +
      `${description}\n` +
      `</mesh-blocker>\n` +
      `<context type="blocker_report">\n` +
      `A subordinate is blocked. Investigate, then either: (a) call revise_task(task_id="${taskId}", feedback="...") with guidance to unblock them, or (b) escalate further if you cannot resolve.\n` +
      `</context>`;
    void this.spawnTargetSession({
      targetAgentId: parentAgentId,
      type: "blocker",
      intent,
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private async checkMeshCapacity(targetAgentId: string): Promise<void> {
    const target = await this.deps.agentRepo.findById(targetAgentId);
    if (!target) {
      throw new Error(`target agent not found: ${targetAgentId}`);
    }
    const cap = target.max_mesh_sessions ?? DEFAULT_MAX_MESH_SESSIONS;
    const running = await this.deps.sessionRepo.countRunningByAgent(
      targetAgentId,
      [...MESH_SESSION_TYPES],
    );
    if (running >= cap) {
      throw new MeshCapacityError(
        `Target agent ${targetAgentId} is at mesh capacity (${running}/${cap}). ` +
          `Try again later, or work on something else in the meantime — ` +
          `their existing mesh sessions will free up shortly.`,
        { agentId: targetAgentId, running, cap },
      );
    }
  }

  /**
   * Spawn the target agent's CLI session via AgentSession.run. Fire-and-
   * forget — the calling tool awaits the resolver, not this promise. The
   * spawn promise's rejection is logged; the session row reflects the
   * crash via the runtime's session-update path.
   *
   * The optional `onSessionCreated` callback fires after AgentSession.run
   * has inserted the session row (so we have the new session id) but
   * before the CLI exits. Used by sendNegotiate to stamp counterparty_
   * session_id on the negotiation row.
   */
  private async spawnTargetSession(opts: {
    targetAgentId: string;
    type: "mesh_ask" | "mesh_negotiate" | "blocker";
    intent: string;
    /** Optional pre-generated sid (used by sendNegotiate). */
    sessionId?: string;
  }): Promise<void> {
    const agent = await this.deps.agentRepo.findById(opts.targetAgentId);
    if (!agent) {
      throw new Error(`target agent not found: ${opts.targetAgentId}`);
    }

    const runtime = this.deps.runtimeRegistry[agent.runtime_config.type];
    if (!runtime) {
      throw new Error(`unsupported runtime: ${agent.runtime_config.type}`);
    }

    const workspace = await this.deps.workspaceManager.ensureWorkspace({ agent });

    const memoryAgent = this.deps.makeMemoryAgent(agent.id);
    const agentSessionDeps: AgentSessionDeps = {
      agentRepo: this.deps.agentRepo,
      sessionRepo: this.deps.sessionRepo,
      runtime,
      memoryAgent,
    };
    const agentSession = new AgentSession(agentSessionDeps);

    void agentSession
      .run({
        agentId: agent.id,
        sessionId: opts.sessionId,
        intent: opts.intent,
        workspace,
        type: opts.type,
      })
      .catch((err: unknown) => {
        console.error(
          `[mesh] spawn for ${agent.id} (${opts.type}) failed:`,
          err instanceof Error ? err.message : err,
        );
      });
  }

  private awaitResolver<T extends AskOrNegotiate>(
    key: string,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.resolvers.delete(key)) {
          reject(new Error(`mesh resolver timeout (${timeoutMs}ms) for ${key}`));
        }
      }, timeoutMs);
      this.resolvers.set(key, {
        resolve: resolve as (response: AskOrNegotiate) => void,
        reject,
        timer,
      });
    });
  }

  private fireResolver(key: string, response: AskOrNegotiate): boolean {
    const entry = this.resolvers.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.resolvers.delete(key);
    entry.resolve(response);
    return true;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/&/g, "&amp;");
}
