import type {
  Negotiation,
  NegotiationDecision,
  NegotiationRound,
  NegotiationStatus,
} from "../../domain/negotiation.js";
import type {
  NegotiationPatch,
  NegotiationRepository,
  NegotiationRoundRepository,
  NewNegotiation,
  NewNegotiationRound,
} from "../../ports/negotiation-repo.js";
import {
  findRowById,
  queryExpectOne,
  queryMany,
  queryOne,
  updateRowById,
} from "./pg-helpers.js";
import type { Pool } from "./client.js";
import type { NegotiationRoundRow, NegotiationRow } from "./row-types.js";

export class PostgresNegotiationRepository implements NegotiationRepository {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<Negotiation | undefined> {
    return findRowById(this.pool, "negotiation", id, rowToNegotiation);
  }

  async findActiveBetween(
    initiatorAgentId: string,
    counterpartyAgentId: string,
  ): Promise<Negotiation | undefined> {
    return queryOne(
      this.pool,
      `SELECT * FROM negotiation
        WHERE status = 'active'
          AND initiator_agent_id = $1
          AND counterparty_agent_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [initiatorAgentId, counterpartyAgentId],
      rowToNegotiation,
    );
  }

  async create(input: NewNegotiation): Promise<Negotiation> {
    return queryExpectOne(
      this.pool,
      `INSERT INTO negotiation (
         id, initiator_agent_id, initiator_session_id,
         counterparty_agent_id, counterparty_session_id,
         task_id, max_rounds, rounds_completed, status
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, COALESCE($8, 0), COALESCE($9, 'active')
       )
       RETURNING *`,
      [
        input.id,
        input.initiator_agent_id,
        input.initiator_session_id,
        input.counterparty_agent_id,
        input.counterparty_session_id ?? null,
        input.task_id ?? null,
        input.max_rounds,
        input.rounds_completed ?? null,
        input.status ?? null,
      ],
      rowToNegotiation,
    );
  }

  async update(id: string, patch: NegotiationPatch): Promise<Negotiation> {
    return updateRowById<NegotiationRow, NegotiationPatch, Negotiation>({
      pool: this.pool,
      table: "negotiation",
      id,
      patch,
      columns: {
        status: "status",
        counterparty_session_id: "counterparty_session_id",
        rounds_completed: "rounds_completed",
      },
      map: rowToNegotiation,
      notFound: (id) => `Negotiation not found: ${id}`,
    });
  }
}

export class PostgresNegotiationRoundRepository implements NegotiationRoundRepository {
  constructor(private pool: Pool) {}

  async listByNegotiation(negotiationId: string): Promise<NegotiationRound[]> {
    return queryMany(
      this.pool,
      `SELECT * FROM negotiation_round
        WHERE negotiation_id = $1
        ORDER BY round_number ASC`,
      [negotiationId],
      rowToRound,
    );
  }

  async findLatest(negotiationId: string): Promise<NegotiationRound | undefined> {
    return queryOne(
      this.pool,
      `SELECT * FROM negotiation_round
        WHERE negotiation_id = $1
        ORDER BY round_number DESC
        LIMIT 1`,
      [negotiationId],
      rowToRound,
    );
  }

  async create(input: NewNegotiationRound): Promise<NegotiationRound> {
    return queryExpectOne(
      this.pool,
      `INSERT INTO negotiation_round (
         id, negotiation_id, round_number, from_agent_id, decision, message
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.id,
        input.negotiation_id,
        input.round_number,
        input.from_agent_id,
        input.decision,
        input.message,
      ],
      rowToRound,
    );
  }
}

function rowToNegotiation(row: NegotiationRow): Negotiation {
  return {
    id: row.id,
    initiator_agent_id: row.initiator_agent_id,
    initiator_session_id: row.initiator_session_id,
    counterparty_agent_id: row.counterparty_agent_id,
    counterparty_session_id: row.counterparty_session_id ?? undefined,
    task_id: row.task_id ?? undefined,
    max_rounds: row.max_rounds,
    rounds_completed: row.rounds_completed,
    status: row.status as NegotiationStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToRound(row: NegotiationRoundRow): NegotiationRound {
  return {
    id: row.id,
    negotiation_id: row.negotiation_id,
    round_number: row.round_number,
    from_agent_id: row.from_agent_id,
    decision: row.decision as NegotiationDecision,
    message: row.message,
    sent_at: row.sent_at,
  };
}
