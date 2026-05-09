import type { Pool } from "./client.js";
import type {
  Room,
  RoomMember,
  RoomMemberKind,
  RoomMessage,
  RoomMessageKind,
} from "../../domain/room.js";
import type {
  NewRoom,
  NewRoomMessage,
  RoomRepository,
} from "../../ports/room-repo.js";

interface RoomRow {
  id: string;
  name: string;
  owner_person_id: string;
  created_at: Date;
  updated_at: Date;
}

interface MemberRow {
  room_id: string;
  kind: RoomMemberKind;
  subject_id: string;
  joined_at: Date;
}

interface MessageRow {
  id: string;
  room_id: string;
  kind: RoomMessageKind;
  sender_person_id: string | null;
  sender_agent_id: string | null;
  content: string;
  session_id: string | null;
  created_at: Date;
}

function rowToRoom(r: RoomRow): Room {
  return {
    id: r.id,
    name: r.name,
    owner_person_id: r.owner_person_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function rowToMessage(r: MessageRow): RoomMessage {
  return {
    id: r.id,
    room_id: r.room_id,
    kind: r.kind,
    ...(r.sender_person_id ? { sender_person_id: r.sender_person_id } : {}),
    ...(r.sender_agent_id ? { sender_agent_id: r.sender_agent_id } : {}),
    content: r.content,
    ...(r.session_id ? { session_id: r.session_id } : {}),
    created_at: r.created_at,
  };
}

export class PostgresRoomRepository implements RoomRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: NewRoom): Promise<Room> {
    const { rows } = await this.pool.query<RoomRow>(
      `INSERT INTO room (id, name, owner_person_id)
       VALUES ($1, $2, $3)
       RETURNING id, name, owner_person_id, created_at, updated_at`,
      [input.id, input.name, input.owner_person_id],
    );
    return rowToRoom(rows[0]!);
  }

  async findById(id: string): Promise<Room | undefined> {
    const { rows } = await this.pool.query<RoomRow>(
      `SELECT id, name, owner_person_id, created_at, updated_at FROM room WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToRoom(rows[0]) : undefined;
  }

  async listForPerson(personId: string): Promise<Room[]> {
    const { rows } = await this.pool.query<RoomRow>(
      `SELECT r.id, r.name, r.owner_person_id, r.created_at, r.updated_at
       FROM room r
       JOIN room_member rm
         ON rm.room_id = r.id AND rm.kind = 'person' AND rm.person_id = $1
       ORDER BY r.updated_at DESC`,
      [personId],
    );
    return rows.map(rowToRoom);
  }

  async addPersonMember(roomId: string, personId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO room_member (room_id, kind, person_id, subject_id)
       VALUES ($1, 'person', $2, $2)
       ON CONFLICT (room_id, subject_id) DO NOTHING`,
      [roomId, personId],
    );
  }

  async addAgentMember(roomId: string, agentId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO room_member (room_id, kind, agent_id, subject_id)
       VALUES ($1, 'agent', $2, $2)
       ON CONFLICT (room_id, subject_id) DO NOTHING`,
      [roomId, agentId],
    );
  }

  async listMembers(roomId: string): Promise<RoomMember[]> {
    const { rows } = await this.pool.query<MemberRow>(
      `SELECT room_id, kind, subject_id, joined_at
       FROM room_member WHERE room_id = $1
       ORDER BY joined_at ASC`,
      [roomId],
    );
    return rows;
  }

  async listMemberPersonIds(roomId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ person_id: string }>(
      `SELECT person_id FROM room_member
       WHERE room_id = $1 AND kind = 'person' AND person_id IS NOT NULL`,
      [roomId],
    );
    return rows.map((r) => r.person_id);
  }

  async listMemberAgentIds(roomId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM room_member
       WHERE room_id = $1 AND kind = 'agent' AND agent_id IS NOT NULL`,
      [roomId],
    );
    return rows.map((r) => r.agent_id);
  }

  async isMember(roomId: string, personId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM room_member
         WHERE room_id = $1 AND kind = 'person' AND person_id = $2
       ) AS exists`,
      [roomId, personId],
    );
    return !!rows[0]?.exists;
  }

  async areAgentsCoMembers(agentA: string, agentB: string): Promise<boolean> {
    if (agentA === agentB) return false;
    const { rows } = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM room_member ra
         JOIN room_member rb
           ON ra.room_id = rb.room_id
         WHERE ra.kind = 'agent' AND ra.agent_id = $1
           AND rb.kind = 'agent' AND rb.agent_id = $2
       ) AS exists`,
      [agentA, agentB],
    );
    return !!rows[0]?.exists;
  }

  async appendMessage(input: NewRoomMessage): Promise<RoomMessage> {
    const { rows } = await this.pool.query<MessageRow>(
      `INSERT INTO room_message
         (id, room_id, kind, sender_person_id, sender_agent_id, content, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, room_id, kind, sender_person_id, sender_agent_id, content,
                 session_id, created_at`,
      [
        input.id,
        input.room_id,
        input.kind,
        input.sender_person_id ?? null,
        input.sender_agent_id ?? null,
        input.content,
        input.session_id ?? null,
      ],
    );
    return rowToMessage(rows[0]!);
  }

  async listMessages(roomId: string, limit = 200): Promise<RoomMessage[]> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT id, room_id, kind, sender_person_id, sender_agent_id, content,
              session_id, created_at
       FROM room_message
       WHERE room_id = $1
       ORDER BY created_at ASC, id ASC
       LIMIT $2`,
      [roomId, limit],
    );
    return rows.map(rowToMessage);
  }
}
