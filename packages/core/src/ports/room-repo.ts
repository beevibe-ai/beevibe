import type { Room, RoomMember, RoomMessage } from "../domain/room.js";

export type NewRoom = Omit<Room, "created_at" | "updated_at">;

export type NewRoomMessage = Omit<RoomMessage, "created_at">;

/**
 * Room persistence. Combines room metadata, membership, and message
 * history. Messages live on the same logical surface as agent
 * sessions — agent messages carry a `session_id` that links to the
 * AgentSession that produced them, so the chat UI can drill into a
 * tool transcript.
 */
export interface RoomRepository {
  // ── Room CRUD ─────────────────────────────────────────────────────────
  create(input: NewRoom): Promise<Room>;
  findById(id: string): Promise<Room | undefined>;
  /** Rooms the person is a member of, newest first. */
  listForPerson(personId: string): Promise<Room[]>;

  // ── Membership ────────────────────────────────────────────────────────
  addPersonMember(roomId: string, personId: string): Promise<void>;
  addAgentMember(roomId: string, agentId: string): Promise<void>;
  listMembers(roomId: string): Promise<RoomMember[]>;
  /** All person ids that are members of this room. Used for SSE fanout. */
  listMemberPersonIds(roomId: string): Promise<string[]>;
  /** All agent ids that are members of this room. */
  listMemberAgentIds(roomId: string): Promise<string[]>;
  isMember(roomId: string, personId: string): Promise<boolean>;
  /** True if both agents are co-members of any room. Used by the mesh ask gate. */
  areAgentsCoMembers(agentA: string, agentB: string): Promise<boolean>;

  // ── Messages ──────────────────────────────────────────────────────────
  appendMessage(input: NewRoomMessage): Promise<RoomMessage>;
  listMessages(roomId: string, limit?: number): Promise<RoomMessage[]>;
}
