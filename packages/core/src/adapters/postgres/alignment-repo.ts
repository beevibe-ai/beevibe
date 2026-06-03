import type { Pool } from "./client.js";
import { buildPatchClause } from "./pg-helpers.js";
import type {
  AlignmentMeeting,
  AlignmentDigest,
  AlignmentDigestSummary,
  AlignmentActionItem,
  AlignmentTargetRef,
} from "../../domain/alignment.js";
import type {
  AlignmentMeetingRepository,
  NewAlignmentMeeting,
  AlignmentMeetingPatch,
  AlignmentDigestRepository,
  NewAlignmentDigest,
  AlignmentActionItemRepository,
  NewAlignmentActionItem,
  AlignmentActionItemPatch,
} from "../../ports/alignment-repo.js";

interface MeetingRow {
  id: string;
  team_agent_id: string;
  owner_person_id: string;
  status: AlignmentMeeting["status"];
  chat_session_id: string | null;
  notes: string;
  created_at: Date;
  updated_at: Date;
  wrapped_at: Date | null;
}

function rowToMeeting(row: MeetingRow): AlignmentMeeting {
  return {
    id: row.id,
    team_agent_id: row.team_agent_id,
    owner_person_id: row.owner_person_id,
    status: row.status,
    chat_session_id: row.chat_session_id,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    wrapped_at: row.wrapped_at,
  };
}

export class PostgresAlignmentMeetingRepository
  implements AlignmentMeetingRepository
{
  constructor(private readonly pool: Pool) {}

  async create(input: NewAlignmentMeeting): Promise<AlignmentMeeting> {
    const { rows } = await this.pool.query<MeetingRow>(
      `INSERT INTO alignment_meeting (id, team_agent_id, owner_person_id, status)
       VALUES ($1, $2, $3, COALESCE($4, 'prepping'))
       RETURNING *`,
      [input.id, input.team_agent_id, input.owner_person_id, input.status ?? null],
    );
    return rowToMeeting(rows[0]!);
  }

  async findById(id: string): Promise<AlignmentMeeting | undefined> {
    const { rows } = await this.pool.query<MeetingRow>(
      `SELECT * FROM alignment_meeting WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToMeeting(rows[0]) : undefined;
  }

  async findByChatSession(
    chatSessionId: string,
  ): Promise<AlignmentMeeting | undefined> {
    const { rows } = await this.pool.query<MeetingRow>(
      `SELECT * FROM alignment_meeting WHERE chat_session_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [chatSessionId],
    );
    return rows[0] ? rowToMeeting(rows[0]) : undefined;
  }

  async listByOwner(
    ownerPersonId: string,
    limit = 50,
  ): Promise<AlignmentMeeting[]> {
    const { rows } = await this.pool.query<MeetingRow>(
      `SELECT * FROM alignment_meeting
        WHERE owner_person_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [ownerPersonId, limit],
    );
    return rows.map(rowToMeeting);
  }

  async update(
    id: string,
    patch: AlignmentMeetingPatch,
  ): Promise<AlignmentMeeting> {
    const clause = buildPatchClause(patch, {
      status: "status",
      chat_session_id: "chat_session_id",
      notes: "notes",
      wrapped_at: "wrapped_at",
    });
    if (clause.fields.length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error(`alignment_meeting ${id} not found`);
      return existing;
    }
    clause.fields.push("updated_at = NOW()");
    const { rows } = await this.pool.query<MeetingRow>(
      `UPDATE alignment_meeting SET ${clause.fields.join(", ")}
        WHERE id = $${clause.nextIndex} RETURNING *`,
      [...clause.values, id],
    );
    if (!rows[0]) throw new Error(`alignment_meeting ${id} not found`);
    return rowToMeeting(rows[0]);
  }
}

interface DigestRow {
  id: string;
  meeting_id: string;
  agent_id: string;
  summary: AlignmentDigestSummary;
  source_block_ids: string[];
  source_fact_ids: string[];
  model: string;
  created_at: Date;
}

function rowToDigest(row: DigestRow): AlignmentDigest {
  return {
    id: row.id,
    meeting_id: row.meeting_id,
    agent_id: row.agent_id,
    summary: row.summary,
    source_block_ids: row.source_block_ids,
    source_fact_ids: row.source_fact_ids,
    model: row.model,
    created_at: row.created_at,
  };
}

export class PostgresAlignmentDigestRepository
  implements AlignmentDigestRepository
{
  constructor(private readonly pool: Pool) {}

  async create(input: NewAlignmentDigest): Promise<AlignmentDigest> {
    const { rows } = await this.pool.query<DigestRow>(
      `INSERT INTO alignment_digest
         (id, meeting_id, agent_id, summary, source_block_ids, source_fact_ids, model)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING *`,
      [
        input.id,
        input.meeting_id,
        input.agent_id,
        JSON.stringify(input.summary),
        input.source_block_ids,
        input.source_fact_ids,
        input.model,
      ],
    );
    return rowToDigest(rows[0]!);
  }

  async listByMeeting(meetingId: string): Promise<AlignmentDigest[]> {
    const { rows } = await this.pool.query<DigestRow>(
      `SELECT * FROM alignment_digest WHERE meeting_id = $1 ORDER BY created_at ASC`,
      [meetingId],
    );
    return rows.map(rowToDigest);
  }
}

interface ActionItemRow {
  id: string;
  meeting_id: string;
  agent_id: string;
  kind: AlignmentActionItem["kind"];
  title: string;
  rationale: string;
  target_ref: AlignmentTargetRef | null;
  status: AlignmentActionItem["status"];
  applied_session_id: string | null;
  applied_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToActionItem(row: ActionItemRow): AlignmentActionItem {
  return {
    id: row.id,
    meeting_id: row.meeting_id,
    agent_id: row.agent_id,
    kind: row.kind,
    title: row.title,
    rationale: row.rationale,
    target_ref: row.target_ref,
    status: row.status,
    applied_session_id: row.applied_session_id,
    applied_at: row.applied_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class PostgresAlignmentActionItemRepository
  implements AlignmentActionItemRepository
{
  constructor(private readonly pool: Pool) {}

  async create(input: NewAlignmentActionItem): Promise<AlignmentActionItem> {
    const { rows } = await this.pool.query<ActionItemRow>(
      `INSERT INTO alignment_action_item
         (id, meeting_id, agent_id, kind, title, rationale, target_ref, status)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, ''), $7::jsonb, COALESCE($8, 'open'))
       RETURNING *`,
      [
        input.id,
        input.meeting_id,
        input.agent_id,
        input.kind,
        input.title,
        input.rationale ?? null,
        input.target_ref ? JSON.stringify(input.target_ref) : null,
        input.status ?? null,
      ],
    );
    return rowToActionItem(rows[0]!);
  }

  async findById(id: string): Promise<AlignmentActionItem | undefined> {
    const { rows } = await this.pool.query<ActionItemRow>(
      `SELECT * FROM alignment_action_item WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToActionItem(rows[0]) : undefined;
  }

  async listByMeeting(meetingId: string): Promise<AlignmentActionItem[]> {
    const { rows } = await this.pool.query<ActionItemRow>(
      `SELECT * FROM alignment_action_item
        WHERE meeting_id = $1 ORDER BY created_at ASC`,
      [meetingId],
    );
    return rows.map(rowToActionItem);
  }

  async update(
    id: string,
    patch: AlignmentActionItemPatch,
  ): Promise<AlignmentActionItem> {
    const clause = buildPatchClause(patch, {
      status: "status",
      applied_session_id: "applied_session_id",
      applied_at: "applied_at",
    });
    if (clause.fields.length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error(`alignment_action_item ${id} not found`);
      return existing;
    }
    clause.fields.push("updated_at = NOW()");
    const { rows } = await this.pool.query<ActionItemRow>(
      `UPDATE alignment_action_item SET ${clause.fields.join(", ")}
        WHERE id = $${clause.nextIndex} RETURNING *`,
      [...clause.values, id],
    );
    if (!rows[0]) throw new Error(`alignment_action_item ${id} not found`);
    return rowToActionItem(rows[0]);
  }
}
