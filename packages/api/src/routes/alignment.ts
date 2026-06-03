/**
 * Human-facing alignment-meeting routes. All require a bv_u_ caller.
 *
 *   POST   /alignment/meetings                     { team_agent_id? } -> prep digests
 *   GET    /alignment/meetings                      list owner's meetings
 *   GET    /alignment/meetings/:id                  meeting + digests + action items
 *   POST   /alignment/meetings/:id/link-session     { chat_session_id }
 *   PATCH  /alignment/meetings/:id/notes            { notes }
 *   POST   /alignment/meetings/:id/wrap             mark wrapped
 *   POST   /alignment/meetings/:id/action-items     { agent_id, kind, title, rationale?, target_ref? }
 *   POST   /alignment/action-items/:id/apply        write the correction back now
 *   POST   /alignment/action-items/:id/dismiss
 *
 * The meeting CONVERSATION itself runs over the existing /chat surface — the
 * web links the chat session to the meeting so the team agent's
 * `correct_subordinate_memory` tool can find it. This router owns the digest,
 * the action items, and the notes — not the chat turn loop.
 */

import { Router, type RequestHandler } from "express";
import type {
  AgentRepository,
  AlignmentMeetingRepository,
  AlignmentDigestRepository,
  AlignmentActionItemRepository,
  AlignmentActionKind,
  AlignmentTargetRef,
} from "@beevibe/core";
import {
  AlignmentService,
  TeamAgentRequiredError,
} from "@beevibe/core/services/alignment";
import { requireHuman } from "../auth/middleware.js";

export interface AlignmentRoutesDeps {
  authMiddleware: RequestHandler;
  alignmentService: AlignmentService;
  meetingRepo: AlignmentMeetingRepository;
  digestRepo: AlignmentDigestRepository;
  actionRepo: AlignmentActionItemRepository;
  agentRepo: AgentRepository;
}

const ACTION_KINDS: readonly AlignmentActionKind[] = [
  "correct_memory",
  "note",
  "followup",
];

export function createAlignmentRouter(deps: AlignmentRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  // Start a meeting: distill each specialist's memory into a digest.
  router.post("/meetings", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const ownerId = req.caller.personId;
    const teamAgentId =
      typeof req.body?.team_agent_id === "string" && req.body.team_agent_id
        ? req.body.team_agent_id
        : req.caller.agentId;

    const team = await deps.agentRepo.findById(teamAgentId);
    if (!team || team.owner_id !== ownerId) {
      res.status(404).json({ error: "agent_not_found" });
      return;
    }

    try {
      const { meeting, digests } = await deps.alignmentService.prepare(
        teamAgentId,
        ownerId,
      );
      const agents = await buildAgentMap(deps, digests.map((d) => d.agent_id));
      res.status(201).json({ meeting, digests, action_items: [], agents });
    } catch (err) {
      if (err instanceof TeamAgentRequiredError) {
        res.status(400).json({ error: "not_a_team_agent", message: err.message });
        return;
      }
      console.error("[alignment] prepare failed:", err);
      res.status(502).json({
        error: "digest_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get("/meetings", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const meetings = await deps.meetingRepo.listByOwner(req.caller.personId);
    res.json({ meetings });
  });

  router.get("/meetings/:id", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const meeting = await deps.meetingRepo.findById(req.params.id);
    if (!meeting || meeting.owner_person_id !== req.caller.personId) {
      res.status(404).json({ error: "meeting_not_found" });
      return;
    }
    const [digests, actionItems] = await Promise.all([
      deps.digestRepo.listByMeeting(meeting.id),
      deps.actionRepo.listByMeeting(meeting.id),
    ]);
    const agentIds = [
      ...digests.map((d) => d.agent_id),
      ...actionItems.map((a) => a.agent_id),
    ];
    const agents = await buildAgentMap(deps, agentIds);
    res.json({ meeting, digests, action_items: actionItems, agents });
  });

  router.post("/meetings/:id/link-session", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const meeting = await deps.meetingRepo.findById(req.params.id);
    if (!meeting || meeting.owner_person_id !== req.caller.personId) {
      res.status(404).json({ error: "meeting_not_found" });
      return;
    }
    const chatSessionId = String(req.body?.chat_session_id ?? "");
    if (!chatSessionId) {
      res.status(400).json({ error: "chat_session_id_required" });
      return;
    }
    // Only set once — the first turn pins the conversation.
    const updated = meeting.chat_session_id
      ? meeting
      : await deps.meetingRepo.update(meeting.id, {
          chat_session_id: chatSessionId,
        });
    res.json({ meeting: updated });
  });

  router.patch("/meetings/:id/notes", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const meeting = await deps.meetingRepo.findById(req.params.id);
    if (!meeting || meeting.owner_person_id !== req.caller.personId) {
      res.status(404).json({ error: "meeting_not_found" });
      return;
    }
    const notes = typeof req.body?.notes === "string" ? req.body.notes : "";
    const updated = await deps.meetingRepo.update(meeting.id, { notes });
    res.json({ meeting: updated });
  });

  router.post("/meetings/:id/wrap", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const meeting = await deps.meetingRepo.findById(req.params.id);
    if (!meeting || meeting.owner_person_id !== req.caller.personId) {
      res.status(404).json({ error: "meeting_not_found" });
      return;
    }
    const updated = await deps.meetingRepo.update(meeting.id, {
      status: "wrapped",
      wrapped_at: new Date(),
    });
    res.json({ meeting: updated });
  });

  router.post("/meetings/:id/action-items", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const meeting = await deps.meetingRepo.findById(req.params.id);
    if (!meeting || meeting.owner_person_id !== req.caller.personId) {
      res.status(404).json({ error: "meeting_not_found" });
      return;
    }
    const agentId = String(req.body?.agent_id ?? "");
    const kind = String(req.body?.kind ?? "") as AlignmentActionKind;
    const title = String(req.body?.title ?? "");
    if (!agentId || !title || !ACTION_KINDS.includes(kind)) {
      res.status(400).json({
        error: "invalid_action_item",
        message: `agent_id, title, and kind (${ACTION_KINDS.join("|")}) required`,
      });
      return;
    }
    const item = await deps.alignmentService.createActionItem({
      meetingId: meeting.id,
      agentId,
      kind,
      title,
      rationale:
        typeof req.body?.rationale === "string" ? req.body.rationale : "",
      targetRef: (req.body?.target_ref as AlignmentTargetRef | undefined) ?? null,
    });
    res.status(201).json({ action_item: item });
  });

  router.post("/action-items/:id/apply", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const item = await deps.actionRepo.findById(req.params.id);
    if (!item) {
      res.status(404).json({ error: "action_item_not_found" });
      return;
    }
    const meeting = await deps.meetingRepo.findById(item.meeting_id);
    if (!meeting || meeting.owner_person_id !== req.caller.personId) {
      res.status(404).json({ error: "action_item_not_found" });
      return;
    }
    try {
      const appliedSessionId = meeting.chat_session_id ?? `manual:${meeting.id}`;
      const updated = await deps.alignmentService.applyActionItem(
        item.id,
        appliedSessionId,
      );
      res.json({ action_item: updated });
    } catch (err) {
      res.status(422).json({
        error: "apply_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post("/action-items/:id/dismiss", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const item = await deps.actionRepo.findById(req.params.id);
    if (!item) {
      res.status(404).json({ error: "action_item_not_found" });
      return;
    }
    const meeting = await deps.meetingRepo.findById(item.meeting_id);
    if (!meeting || meeting.owner_person_id !== req.caller.personId) {
      res.status(404).json({ error: "action_item_not_found" });
      return;
    }
    const updated = await deps.alignmentService.dismissActionItem(item.id);
    res.json({ action_item: updated });
  });

  return router;
}

/** Resolve { agent_id -> { name, hierarchy_level } } for the digests/actions. */
async function buildAgentMap(
  deps: Pick<AlignmentRoutesDeps, "agentRepo">,
  agentIds: string[],
): Promise<Record<string, { name: string; hierarchy_level: string }>> {
  const unique = [...new Set(agentIds)];
  const entries = await Promise.all(
    unique.map(async (id) => {
      const agent = await deps.agentRepo.findById(id);
      return [
        id,
        {
          name: agent?.name ?? id,
          hierarchy_level: agent?.hierarchy_level ?? "ic",
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}
