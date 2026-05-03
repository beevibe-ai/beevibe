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

  // ── Self-join (post-invite-link signup) ───────────────────────────────
  // Any signed-in caller can join any room they have the id for. URL is
  // the bearer of trust — same model as Slack/Discord shareable invites.
  // Caller's primary team agent is added as an agent member alongside.
  router.post("/:id/join", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const id = req.params.id ?? "";
      const room = await deps.roomRepo.findById(id);
      if (!room) {
        res.status(404).json({ error: "room_not_found" });
        return;
      }
      await deps.roomRepo.addPersonMember(id, req.caller.personId);
      const team = await deps.agentRepo.findTopLevelForOwner(req.caller.personId);
      if (team) await deps.roomRepo.addAgentMember(id, team.id);
      res.json({ ok: true, room });
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

      // Persist the human message FIRST + return immediately. The
      // bv_event trigger fires room.message → SSE → every member's
      // browser invalidates and refetches → human's words appear in
      // ALL panes within a tick. Critical for the demo: while one
      // user is typing, the other should see "is sending..." → "did
      // send" without 30s of silence waiting for an agent run.
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

      // Send the response now — agent runs are fire-and-forget. Each
      // agent's session_event stream + final room_message row fan
      // out via SSE as they happen. Sequential (not parallel) so the
      // room transcript stays readable.
      res.json({
        ok: true,
        message: toMessageReply(humanMsg),
        invoked_agents: mentionedAgents.map((a) => ({ id: a.id, name: a.name })),
      });

      void runMentionedAgents(
        deps,
        roomId,
        req.caller.personId,
        content,
        mentionedAgents,
      );
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

const ROOM_CONTEXT_TURNS = 25;
const ROOM_CONTEXT_PREVIEW_CHARS = 800;

/**
 * Build a room-aware intent prompt. Without the rest of the
 * conversation, an @-mentioned agent sees only the literal message
 * the human typed — frequently just `@<agent_id>`, which gives it
 * nothing to act on. Inline the recent transcript + the room's
 * member list so the agent has the same context the humans have.
 */
async function buildRoomIntent(
  deps: RoomRoutesDeps,
  roomId: string,
  selfAgentId: string,
  triggerPersonId: string,
  triggerContent: string,
): Promise<string> {
  const [room, members, allMessages] = await Promise.all([
    deps.roomRepo.findById(roomId),
    deps.roomRepo.listMembers(roomId),
    deps.roomRepo.listMessages(roomId, ROOM_CONTEXT_TURNS + 1),
  ]);
  if (!room) return triggerContent;

  // Hydrate members for display labels.
  const personIds = members.filter((m) => m.kind === "person").map((m) => m.subject_id);
  const agentIds = members.filter((m) => m.kind === "agent").map((m) => m.subject_id);
  const [persons, agents] = await Promise.all([
    Promise.all(personIds.map((pid) => deps.personRepo.findById(pid))),
    Promise.all(agentIds.map((aid) => deps.agentRepo.findById(aid))),
  ]);
  const personById = new Map(persons.filter((p) => p).map((p) => [p!.id, p!]));
  const agentById = new Map(agents.filter((a) => a).map((a) => [a!.id, a!]));

  const labelFor = (m: { kind: "human" | "agent"; sender_person_id?: string; sender_agent_id?: string }): string => {
    if (m.kind === "human" && m.sender_person_id) {
      return personById.get(m.sender_person_id)?.name ?? "human";
    }
    if (m.kind === "agent" && m.sender_agent_id) {
      const ag = agentById.get(m.sender_agent_id);
      return ag ? `${ag.name} (${ag.id})` : "agent";
    }
    return "?";
  };

  // The triggering message is appended fresh below; the listMessages
  // call already includes it, so trim it off the history slice to
  // avoid duplication.
  const history = allMessages.slice(0, -1).slice(-ROOM_CONTEXT_TURNS);
  const transcript = history
    .map((m) => {
      const truncated =
        m.content.length > ROOM_CONTEXT_PREVIEW_CHARS
          ? m.content.slice(0, ROOM_CONTEXT_PREVIEW_CHARS - 1) + "…"
          : m.content;
      return `${labelFor(m)}: ${truncated}`;
    })
    .join("\n\n");

  const memberLines: string[] = [];
  for (const p of persons) if (p) memberLines.push(`- ${p.name} (human, ${p.id})`);
  for (const a of agents) {
    if (!a) continue;
    const tag = a.id === selfAgentId ? " [you]" : "";
    memberLines.push(`- ${a.name} (agent, ${a.id})${tag}`);
  }

  const triggerName = personById.get(triggerPersonId)?.name ?? "a human";

  return `<room name="${room.name.replace(/"/g, "&quot;")}" id="${room.id}">
You are participating in a shared room. The full member list and
recent conversation are below — read them so you understand what's
being discussed before you reply.

## Members
${memberLines.join("\n")}

${
  transcript
    ? `## Recent conversation (oldest first)\n${transcript}\n`
    : "## Recent conversation\n(none yet — this is the first turn)\n"
}

## Latest message addressed to you
${triggerName} said: ${triggerContent}

Respond as ${selfAgentId}. Speak directly to the room.
</room>`;
}

/**
 * Run @mentioned agents sequentially in the background. Each writes
 * its final response as a `room_message` row, which fires the
 * room.message bv_event trigger so every member's browser refetches
 * and renders it in the same tick. Failures are logged + persisted as
 * an agent-kind message so room members can see what went wrong
 * instead of staring at silence.
 */
async function runMentionedAgents(
  deps: RoomRoutesDeps,
  roomId: string,
  triggerPersonId: string,
  triggerContent: string,
  agents: { id: string; runtime_config: { type: string } }[],
): Promise<void> {
  for (const a of agents) {
    try {
      const agent = await deps.agentRepo.findById(a.id);
      if (!agent) continue;
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
      const intent = await buildRoomIntent(
        deps,
        roomId,
        agent.id,
        triggerPersonId,
        triggerContent,
      );
      const session = await agentSession.run({
        agentId: agent.id,
        intent,
        workspace,
        type: "chat",
        roomId,
        extraSystemPromptAppend: ROOM_DIRECTIVES,
      });
      const visible = session.result_summary ?? "";
      await deps.roomRepo.appendMessage({
        id: makeRoomMessageId(),
        room_id: roomId,
        kind: "agent",
        sender_agent_id: agent.id,
        content: visible,
        session_id: session.id,
      });
    } catch (err) {
      console.error(
        `[room route] agent ${a.id} failed during room ${roomId} turn:`,
        err instanceof Error ? err.message : err,
      );
      try {
        await deps.roomRepo.appendMessage({
          id: makeRoomMessageId(),
          room_id: roomId,
          kind: "agent",
          sender_agent_id: a.id,
          content: `(error: ${(err as Error).message})`,
        });
      } catch {
        // best-effort
      }
    }
  }
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
