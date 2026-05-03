/**
 * Room — multi-tenant collaboration space.
 *
 * Rooms hold a fixed set of human + agent participants. Humans send
 * plain-text messages or @mention an agent to invoke it. Agents who
 * are co-members of a room can `ask` each other via mesh (the peer
 * check is relaxed for co-membership).
 */

export interface Room {
  id: string;
  name: string;
  owner_person_id: string;
  created_at: Date;
  updated_at: Date;
}

export type RoomMemberKind = "person" | "agent";

export interface RoomMember {
  room_id: string;
  kind: RoomMemberKind;
  /** subject_id always = person_id for human members, agent_id for agent members. */
  subject_id: string;
  joined_at: Date;
}

export type RoomMessageKind = "human" | "agent";

export interface RoomMessage {
  id: string;
  room_id: string;
  kind: RoomMessageKind;
  /** Set when kind='human'. */
  sender_person_id?: string;
  /** Set when kind='agent'. */
  sender_agent_id?: string;
  content: string;
  /** Set on agent messages — the AgentSession that produced this turn. */
  session_id?: string;
  created_at: Date;
}
