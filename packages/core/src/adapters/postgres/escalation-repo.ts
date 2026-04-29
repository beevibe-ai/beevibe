import type {
  Escalation,
  EscalationStatus,
  Proposal,
  ResolutionProposal,
} from "../../domain/escalation.js";
import type {
  EscalationPatch,
  EscalationRepository,
  NewEscalation,
} from "../../ports/escalation-repo.js";
import { buildPatchClause } from "./pg-helpers.js";
import type { Pool } from "./client.js";
import type { EscalationRow } from "./row-types.js";

export class PostgresEscalationRepository implements EscalationRepository {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<Escalation | undefined> {
    const { rows } = await this.pool.query<EscalationRow>(
      `SELECT * FROM escalation WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? rowToEscalation(rows[0]) : undefined;
  }

  async findByNegotiation(negotiationId: string): Promise<Escalation | undefined> {
    const { rows } = await this.pool.query<EscalationRow>(
      `SELECT * FROM escalation WHERE negotiation_id = $1 LIMIT 1`,
      [negotiationId],
    );
    return rows[0] ? rowToEscalation(rows[0]) : undefined;
  }

  async listPending(): Promise<Escalation[]> {
    const { rows } = await this.pool.query<EscalationRow>(
      `SELECT * FROM escalation
        WHERE status = 'pending'
        ORDER BY created_at ASC`,
    );
    return rows.map(rowToEscalation);
  }

  async create(input: NewEscalation): Promise<Escalation> {
    const { rows } = await this.pool.query<EscalationRow>(
      `INSERT INTO escalation (
         id, negotiation_id, initiator_session_id, counterparty_session_id,
         summary,
         initiator_proposals, initiator_open_questions, initiator_submitted_at,
         escalated_by_role, status
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::jsonb, COALESCE($7, '{}'::text[]), $8,
         $9, COALESCE($10, 'pending')
       )
       RETURNING *`,
      [
        input.id,
        input.negotiation_id,
        input.initiator_session_id,
        input.counterparty_session_id,
        input.summary,
        // JSONB columns: pg driver doesn't auto-stringify JS arrays/objects
        // for jsonb. Stringify here; rowToEscalation casts back via the row's
        // typed shape.
        input.initiator_proposals ? JSON.stringify(input.initiator_proposals) : null,
        input.initiator_open_questions ?? null,
        input.initiator_submitted_at ?? null,
        input.escalated_by_role,
        input.status ?? null,
      ],
    );
    return rowToEscalation(rows[0]!);
  }

  async update(id: string, patch: EscalationPatch): Promise<Escalation> {
    // pg driver auto-stringifies plain objects to jsonb but treats arrays as
    // Postgres arrays. For our JSONB array/object columns (proposals,
    // resolution_proposal), pre-stringify so the driver passes `text` and
    // the SQL casts via column type. Untouched fields stay undefined and
    // `buildPatchClause` skips them.
    const stringified: EscalationPatch = {
      ...patch,
      ...(patch.counterparty_proposals !== undefined && {
        counterparty_proposals: JSON.stringify(patch.counterparty_proposals) as unknown as never,
      }),
      ...(patch.initiator_proposals !== undefined && {
        initiator_proposals: JSON.stringify(patch.initiator_proposals) as unknown as never,
      }),
      ...(patch.resolution_proposal !== undefined && {
        resolution_proposal: JSON.stringify(patch.resolution_proposal) as unknown as never,
      }),
    };

    const clause = buildPatchClause<EscalationPatch>(stringified, {
      counterparty_proposals: "counterparty_proposals",
      counterparty_open_questions: "counterparty_open_questions",
      counterparty_submitted_at: "counterparty_submitted_at",
      initiator_proposals: "initiator_proposals",
      initiator_open_questions: "initiator_open_questions",
      initiator_submitted_at: "initiator_submitted_at",
      status: "status",
      resolution_proposal: "resolution_proposal",
      resolution_notes: "resolution_notes",
      resolved_by: "resolved_by",
      resolved_at: "resolved_at",
    });

    if (clause.fields.length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error(`Escalation not found: ${id}`);
      return existing;
    }

    clause.fields.push(`updated_at = NOW()`);

    const { rows } = await this.pool.query<EscalationRow>(
      `UPDATE escalation SET ${clause.fields.join(", ")} WHERE id = $${clause.nextIndex} RETURNING *`,
      [...clause.values, id],
    );
    if (!rows[0]) throw new Error(`Escalation not found: ${id}`);
    return rowToEscalation(rows[0]);
  }
}

function rowToEscalation(row: EscalationRow): Escalation {
  return {
    id: row.id,
    negotiation_id: row.negotiation_id,
    initiator_session_id: row.initiator_session_id,
    counterparty_session_id: row.counterparty_session_id,
    summary: row.summary,
    initiator_proposals: (row.initiator_proposals as Proposal[] | null) ?? undefined,
    initiator_open_questions: row.initiator_open_questions,
    initiator_submitted_at: row.initiator_submitted_at ?? undefined,
    counterparty_proposals: (row.counterparty_proposals as Proposal[] | null) ?? undefined,
    counterparty_open_questions: row.counterparty_open_questions,
    counterparty_submitted_at: row.counterparty_submitted_at ?? undefined,
    escalated_by_role: row.escalated_by_role as "initiator" | "counterparty",
    status: row.status as EscalationStatus,
    resolution_proposal:
      (row.resolution_proposal as ResolutionProposal | null) ?? undefined,
    resolution_notes: row.resolution_notes ?? undefined,
    resolved_by: row.resolved_by ?? undefined,
    resolved_at: row.resolved_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
