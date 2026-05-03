/**
 * Rooms — multi-tenant chat surface where multiple humans + their
 * team agents collaborate.
 *
 * - `POST /room` creates a room with the caller as owner + their
 *   primary team agent as first agent member.
 * - `GET /room` lists rooms the caller is a member of.
 * - `GET /room/:id` returns the room with its member list + recent
 *   messages.
 * - `POST /room/:id/invite { email }` adds a person (must already
 *   exist) plus their team agent to the room.
 * - `POST /room/:id/message { content }` posts a human turn. If the
 *   content contains `@<agent_id>` for any agent member, that agent
 *   is invoked via AgentSession.run with `room_id` stamped on its
 *   session. The agent's response gets appended as a room_message of
 *   kind='agent' once the session completes.
 *
 * The `@mention` syntax is forgiving — agents are matched by full id
 * OR short id OR exact name (case-insensitive). Many mentions in one
 * turn run sequentially.
 */

import { Router, type RequestHandler, type Response } from "express";
import {
  AgentSession,
  type AgentSessionDeps,
} from "@beevibe/core/services/agent-session";
import {
  roomId as makeRoomId,
  roomMessageId as makeRoomMessageId,
  type AgentRepository,
  type PersonRepository,
  type Room,
  type RoomMessage,
  type RoomRepository,
  type RuntimeRegistry,
  type SessionEventRepository,
  type SessionRepository,
  type WorkspaceManager,
} from "@beevibe/core";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import { requireHuman } from "../auth/middleware.js";

export interface RoomRoutesDeps {
  authMiddleware: RequestHandler;
  roomRepo: RoomRepository;
  agentRepo: AgentRepository;
  personRepo: PersonRepository;
  sessionRepo: SessionRepository;
  sessionEventRepo: SessionEventRepository;
  workspaceManager: WorkspaceManager;
  runtimeRegistry: RuntimeRegistry;
  makeMemoryAgent: (agentId: string) => MemoryAgent;
}

const ROOM_DIRECTIVES = `
You are participating in a SHARED ROOM with multiple humans and one
or more peer team agents. The conversation is a group chat — every
message you produce is visible to ALL room members in real time. A
few directives:

1. **Address the room.** Multiple humans are watching; don't speak
   as if there's only one. When you reference a teammate by name,
   they see it.

2. **You may collaborate with peer agents in this room** via the
   \`ask\` and \`negotiate\` mesh tools. The peer-check is relaxed for
   room co-members — you can ask each other directly even if you're
   from different humans' trees. Use this when a peer's domain
   knowledge is relevant.

3. **Reference any task / agent / session by full id** to make it
   clickable for everyone in the room.

4. **End with 2–4 \`<suggest_action>\` chips** giving humans concrete
   next moves the way you'd in 1:1 chat.
`.trim();

const MENTION_RE = /@([A-Za-z0-9_]+)/g;

interface MessageReply {
  id: string;
  room_id: string;
  kind: "human" | "agent";
  content: string;
  sender_person_id?: string;
  sender_agent_id?: string;
  session_id?: string;
  created_at: string;
}

function toMessageReply(m: RoomMessage): MessageReply {
  return {
    id: m.id,
    room_id: m.room_id,
    kind: m.kind,
    content: m.content,
    ...(m.sender_person_id ? { sender_person_id: m.sender_person_id } : {}),
    ...(m.sender_agent_id ? { sender_agent_id: m.sender_agent_id } : {}),
    ...(m.session_id ? { session_id: m.session_id } : {}),
    created_at: m.created_at.toISOString(),
  };
}

function handleError(err: unknown, res: Response): void {
  console.error("[room route]", err);
  res.status(500).json({
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
}

export function createRoomRouter(deps: RoomRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  // ── Create ─────────────────────────────────────────────────────────────
  router.post("/", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        res.status(400).json({ error: "name_required" });
        return;
      }
      const team = await deps.agentRepo.findTopLevelForOwner(req.caller.personId);
      const room = await deps.roomRepo.create({
        id: makeRoomId(),
        name,
        owner_person_id: req.caller.personId,
      });
      await deps.roomRepo.addPersonMember(room.id, req.caller.personId);
      if (team) await deps.roomRepo.addAgentMember(room.id, team.id);
      res.json({ ok: true, room });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── List ──────────────────────────────────────────────────────────────
  router.get("/", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const rooms = await deps.roomRepo.listForPerson(req.caller.personId);
      res.json({ ok: true, rooms });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Detail ─────────────────────────────────────────────────────────────
  router.get("/:id", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const id = req.params.id ?? "";
      if (!(await deps.roomRepo.isMember(id, req.caller.personId))) {
        res.status(404).json({ error: "room_not_found" });
        return;
      }
      const [room, members, messages] = await Promise.all([
        deps.roomRepo.findById(id),
        deps.roomRepo.listMembers(id),
        deps.roomRepo.listMessages(id, 200),
      ]);
      if (!room) {
        res.status(404).json({ error: "room_not_found" });
        return;
      }
      // Hydrate member labels: people get name+email, agents get name+hierarchy.
      const personIds = members.filter((m) => m.kind === "person").map((m) => m.subject_id);
      const agentIds = members.filter((m) => m.kind === "agent").map((m) => m.subject_id);
      const [persons, agents] = await Promise.all([
        Promise.all(personIds.map((pid) => deps.personRepo.findById(pid))),
        Promise.all(agentIds.map((aid) => deps.agentRepo.findById(aid))),
      ]);
      const memberDetail = [
        ...persons.filter((p) => p).map((p) => ({
          kind: "person" as const,
          id: p!.id,
          name: p!.name,
          email: p!.email ?? null,
        })),
        ...agents.filter((a) => a).map((a) => ({
          kind: "agent" as const,
          id: a!.id,
          name: a!.name,
          hierarchy: a!.hierarchy_level,
          owner_person_id: a!.owner_id,
        })),
      ];
      res.json({
        ok: true,
        room,
        members: memberDetail,
        messages: messages.map(toMessageReply),
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Invite ─────────────────────────────────────────────────────────────
  router.post("/:id/invite", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const id = req.params.id ?? "";
      if (!(await deps.roomRepo.isMember(id, req.caller.personId))) {
        res.status(404).json({ error: "room_not_found" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!email) {
        res.status(400).json({ error: "email_required" });
        return;
      }
      const person = await deps.personRepo.findByEmail(email);
      if (!person) {
        res.status(404).json({
          error: "person_not_found",
          message: `No user with email '${email}'. Ask them to sign up first.`,
        });
        return;
      }
      await deps.roomRepo.addPersonMember(id, person.id);
      const team = await deps.agentRepo.findTopLevelForOwner(person.id);
      if (team) await deps.roomRepo.addAgentMember(id, team.id);
      res.json({
        ok: true,
        invited: { person_id: person.id, name: person.name, email: person.email },
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Message ────────────────────────────────────────────────────────────
  router.post("/:id/message", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const roomId = req.params.id ?? "";
      if (!(await deps.roomRepo.isMember(roomId, req.caller.personId))) {
        res.status(404).json({ error: "room_not_found" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (!content) {
        res.status(400).json({ error: "content_required" });
        return;
      }

      // Persist the human message first — it shows immediately to all
      // room members via SSE while any mentioned agents run in the
      // background.
      const humanMsg = await deps.roomRepo.appendMessage({
        id: makeRoomMessageId(),
        room_id: roomId,
        kind: "human",
        sender_person_id: req.caller.personId,
        content,
      });

      // Resolve @mentions to agent ids. Match against full id, short
      // id (last 6 chars after underscore), or exact name (CI). Agent
      // must be a member of THIS room.
      const memberAgentIds = await deps.roomRepo.listMemberAgentIds(roomId);
      const memberAgents = (
        await Promise.all(memberAgentIds.map((id) => deps.agentRepo.findById(id)))
      ).filter((a) => a !== undefined);

      const mentionedAgents = resolveMentions(content, memberAgents);

      // Run mentioned agents sequentially (one room turn at a time
      // keeps the conversation legible — parallel responses would
      // interleave confusingly). Each runs with room_id stamped so
      // its session events fan out to every room member.
      const agentResponses: MessageReply[] = [];
      for (const agent of mentionedAgents) {
        const runtime = deps.runtimeRegistry[agent.runtime_config.type];
        if (!runtime) {
          await deps.roomRepo.appendMessage({
            id: makeRoomMessageId(),
            room_id: roomId,
            kind: "agent",
            sender_agent_id: agent.id,
            content: `(error: runtime '${agent.runtime_config.type}' not registered)`,
          });
          continue;
        }
        const workspace = await deps.workspaceManager.ensureWorkspace({ agent });
        const agentSessionDeps: AgentSessionDeps = {
          agentRepo: deps.agentRepo,
          sessionRepo: deps.sessionRepo,
          sessionEventRepo: deps.sessionEventRepo,
          runtime,
          memoryAgent: deps.makeMemoryAgent(agent.id),
        };
        const agentSession = new AgentSession(agentSessionDeps);
        const session = await agentSession.run({
          agentId: agent.id,
          intent: content,
          workspace,
          type: "chat",
          roomId,
          extraSystemPromptAppend: ROOM_DIRECTIVES,
        });
        const visible = session.result_summary ?? "";
        const persisted = await deps.roomRepo.appendMessage({
          id: makeRoomMessageId(),
          room_id: roomId,
          kind: "agent",
          sender_agent_id: agent.id,
          content: visible,
          session_id: session.id,
        });
        agentResponses.push(toMessageReply(persisted));
      }

      res.json({
        ok: true,
        message: toMessageReply(humanMsg),
        agent_responses: agentResponses,
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

interface AgentMatchable {
  id: string;
  name: string;
}

/**
 * Match each `@mention` in `content` against a member agent. Tokens
 * after the @ may be the agent's full id, its short id (the suffix
 * after the underscore), or its name with non-alphanumerics stripped.
 * Returns matched agents in mention order, deduped.
 */
function resolveMentions<A extends AgentMatchable>(
  content: string,
  memberAgents: A[],
): A[] {
  const matches = [...content.matchAll(MENTION_RE)];
  if (matches.length === 0) return [];

  const byFullId = new Map<string, A>();
  const byShortId = new Map<string, A>();
  const byName = new Map<string, A>();
  for (const a of memberAgents) {
    byFullId.set(a.id.toLowerCase(), a);
    const short = a.id.split("_").slice(1).join("_").toLowerCase();
    if (short) byShortId.set(short, a);
    byName.set(a.name.toLowerCase().replace(/[^a-z0-9]/g, ""), a);
  }

  const seen = new Set<string>();
  const out: A[] = [];
  for (const m of matches) {
    const token = (m[1] ?? "").toLowerCase();
    const matched =
      byFullId.get(token) ??
      byShortId.get(token) ??
      byName.get(token.replace(/[^a-z0-9]/g, ""));
    if (matched && !seen.has(matched.id)) {
      seen.add(matched.id);
      out.push(matched);
    }
  }
  return out;
}
