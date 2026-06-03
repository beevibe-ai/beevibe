import type {
  AlignmentMeeting,
  AlignmentMeetingStatus,
  AlignmentDigest,
  AlignmentDigestSummary,
  AlignmentActionItem,
  AlignmentActionKind,
  AlignmentActionStatus,
  AlignmentTargetRef,
} from "../domain/alignment.js";

export interface NewAlignmentMeeting {
  id: string;
  team_agent_id: string;
  owner_person_id: string;
  status?: AlignmentMeetingStatus;
}

export interface AlignmentMeetingPatch {
  status?: AlignmentMeetingStatus;
  chat_session_id?: string | null;
  notes?: string;
  wrapped_at?: Date | null;
}

export interface AlignmentMeetingRepository {
  create(input: NewAlignmentMeeting): Promise<AlignmentMeeting>;
  findById(id: string): Promise<AlignmentMeeting | undefined>;
  findByChatSession(chatSessionId: string): Promise<AlignmentMeeting | undefined>;
  listByOwner(ownerPersonId: string, limit?: number): Promise<AlignmentMeeting[]>;
  update(id: string, patch: AlignmentMeetingPatch): Promise<AlignmentMeeting>;
}

export interface NewAlignmentDigest {
  id: string;
  meeting_id: string;
  agent_id: string;
  summary: AlignmentDigestSummary;
  source_block_ids: string[];
  source_fact_ids: string[];
  model: string;
}

export interface AlignmentDigestRepository {
  create(input: NewAlignmentDigest): Promise<AlignmentDigest>;
  listByMeeting(meetingId: string): Promise<AlignmentDigest[]>;
}

export interface NewAlignmentActionItem {
  id: string;
  meeting_id: string;
  agent_id: string;
  kind: AlignmentActionKind;
  title: string;
  rationale?: string;
  target_ref?: AlignmentTargetRef | null;
  status?: AlignmentActionStatus;
}

export interface AlignmentActionItemPatch {
  status?: AlignmentActionStatus;
  applied_session_id?: string | null;
  applied_at?: Date | null;
}

export interface AlignmentActionItemRepository {
  create(input: NewAlignmentActionItem): Promise<AlignmentActionItem>;
  findById(id: string): Promise<AlignmentActionItem | undefined>;
  listByMeeting(meetingId: string): Promise<AlignmentActionItem[]>;
  update(id: string, patch: AlignmentActionItemPatch): Promise<AlignmentActionItem>;
}
