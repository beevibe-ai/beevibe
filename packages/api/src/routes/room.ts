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
import {
  processResponse,
  type OpenView,
  type SuggestedAction,
} from "./directives.js";

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
message you produce is visible to ALL room members in real time.

You're being invoked because a human addressed you in one of these
ways:

  - **Explicit \`@mention\` with your id** — they're talking
    directly to you.
  - **Your name appears in the message** ("Bob's team, can you...")
    — same; they want you specifically.
  - **Generic team-address** ("team", "agents", "specialist") — you
    are the speaker's own team agent and they want a default voice.

Other room members may include peer team agents from different
humans' trees. They're addressable; your peer-check is relaxed for
room co-members.

Operating directives:

1. **Address the room.** Multiple humans are watching; don't speak
   as if there's only one. When you reference a teammate by name,
   they see it.

2. **Collaborate with peer agents** via the \`ask\` and \`negotiate\`
   mesh tools when a peer's domain knowledge is relevant. Don't
   hesitate — that's the design.

3. **Reference any task / agent / session by full id** to make it
   clickable for everyone in the room.

4. **End with 2–4 \`<suggest_action>\` chips** giving humans concrete
   next moves the way you'd in 1:1 chat.

5. **Stay quiet when the room isn't talking to you.** If the recent
   transcript shows humans chatting among themselves with no
   agent-directed asks, a brief or terse reply (or a \`(no action
   needed)\` ack) is the right behavior — don't manufacture work.
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
  view_refs?: string[];
  open_view?: OpenView;
  suggested_actions?: SuggestedAction[];
  created_at: string;
}

function toMessageReply(m: RoomMessage): MessageReply {
  // Agent messages may contain `<suggest_action>` / `<open_view>`
  // directives + inline entity refs. Strip them from the visible
  // content here so the markdown renderer never sees raw XML, and
  // surface the parsed directives as siblings on the reply so the
  // chat UI can render chips + CTAs the same way it does in /chat.
  if (m.kind === "agent") {
    const parsed = processResponse(m.content);
    return {
      id: m.id,
      room_id: m.room_id,
      kind: m.kind,
      content: parsed.visible,
      ...(m.sender_agent_id ? { sender_agent_id: m.sender_agent_id } : {}),
      ...(m.session_id ? { session_id: m.session_id } : {}),
      ...(parsed.view_refs.length > 0 ? { view_refs: parsed.view_refs } : {}),
      ...(parsed.open_view ? { open_view: parsed.open_view } : {}),
      ...(parsed.suggested_actions ? { suggested_actions: parsed.suggested_actions } : {}),
      created_at: m.created_at.toISOString(),
    };
  }
  return {
    id: m.id,
    room_id: m.room_id,
    kind: m.kind,
    content: m.content,
    ...(m.sender_person_id ? { sender_person_id: m.sender_person_id } : {}),
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
      const [room, members, messages, runningSessions] = await Promise.all([
        deps.roomRepo.findById(id),
        deps.roomRepo.listMembers(id),
        deps.roomRepo.listMessages(id, 200),
        deps.sessionRepo.listRunningInRoom(id),
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
      // Typing indicators — agents currently working on a turn for
      // this room. Hydrate names so the UI can render "Bob's team is
      // typing…" without a second round-trip.
      const agentByIdLocal = new Map(agents.filter((a) => a).map((a) => [a!.id, a!]));
      const typing = runningSessions
        .filter((s) => agentByIdLocal.has(s.agent_id))
        .map((s) => ({
          session_id: s.id,
          agent_id: s.agent_id,
          agent_name: agentByIdLocal.get(s.agent_id)!.name,
          started_at: (s.started_at ?? s.created_at).toISOString(),
        }));

      res.json({
        ok: true,
        room,
        members: memberDetail,
        messages: messages.map(toMessageReply),
        typing,
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

      // Resolve who, if anyone, the message addresses. Order:
      //   1. explicit @mention      → those agents
      //   2. agent name in the text → that agent
      //   3. "team" / "agents" word → speaker's own team agent
      //   4. otherwise              → no one (pure human chat)
      const memberAgentIds = await deps.roomRepo.listMemberAgentIds(roomId);
      const memberAgents = (
        await Promise.all(memberAgentIds.map((id) => deps.agentRepo.findById(id)))
      ).filter((a) => a !== undefined);

      const speakerOwn = await deps.agentRepo.findTopLevelForOwner(req.caller.personId);
      const { agents: addressed, reason } = resolveAddressees(
        content,
        memberAgents,
        speakerOwn?.id,
      );

      // Send the response now — agent runs are fire-and-forget. Each
      // agent's session_event stream + final room_message row fan
      // out via SSE as they happen. Sequential (not parallel) so the
      // room transcript stays readable.
      res.json({
        ok: true,
        message: toMessageReply(humanMsg),
        invoked_agents: addressed.map((a) => ({ id: a.id, name: a.name })),
        invoked_reason: reason,
      });

      void runMentionedAgents(
        deps,
        roomId,
        req.caller.personId,
        content,
        addressed,
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
      // Resume the agent's prior room conversation if it has one —
      // warm prompt cache + continuous CLI memory rather than a
      // cold-start every turn. The full transcript still rides on
      // `intent` so an agent that hasn't talked in this room before
      // (or whose CLI session expired) gets the same context.
      const prior = await deps.sessionRepo.findLatestForAgentInRoom(
        agent.id,
        roomId,
      );
      const session = await agentSession.run({
        agentId: agent.id,
        intent,
        workspace,
        type: "chat",
        roomId,
        ...(prior ? { priorSessionId: prior.id } : {}),
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

export type AddresseeReason = "mention" | "name" | "team-default" | "none";

/**
 * Decide which agents (if any) should respond to a human room post.
 * The rule is intentionally simple — humans should be able to predict
 * exactly when an agent will chime in:
 *
 *   1. Explicit `@mention` — that agent. Wins over everything else.
 *   2. Agent's name appears in the message ("Bob's team, can you...").
 *   3. Generic team-address keywords ("team", "agents", "specialist")
 *      with no specific addressee → speaker's own team agent.
 *   4. Otherwise → no agent. Pure human-to-human chat stays silent.
 *
 * Returned agents run sequentially in `runMentionedAgents`. Reason is
 * surfaced in the response so the UI can attribute "your team agent
 * heard 'team' and chimed in" if we ever want to render it.
 */
export function resolveAddressees<A extends AgentMatchable>(
  content: string,
  memberAgents: readonly A[],
  speakerOwnerAgentId: string | undefined,
): { agents: A[]; reason: AddresseeReason } {
  // 1. Explicit mention. @<full_id> | @<short_id> | @<normalized_name>.
  const mentions = resolveMentions(content, memberAgents);
  if (mentions.length > 0) return { agents: mentions, reason: "mention" };

  // 2. Name-substring match. Agent's full normalized name must appear
  // in the normalized message text. Min length 4 so nothing matches
  // by accident on short common words.
  const named = matchAgentsByName(content, memberAgents);
  if (named.length > 0) return { agents: named, reason: "name" };

  // 3. Generic team-address. Speaker's own team agent answers.
  if (TEAM_ADDRESS_RE.test(content) && speakerOwnerAgentId) {
    const own = memberAgents.find((a) => a.id === speakerOwnerAgentId);
    if (own) return { agents: [own], reason: "team-default" };
  }

  return { agents: [], reason: "none" };
}

const TEAM_ADDRESS_RE = /\b(teams?|agents?|specialists?|assistants?)\b/i;

/**
 * Match each `@mention` in `content` against a member agent. Tokens
 * after the @ may be the agent's full id, its short id (the suffix
 * after the underscore), or its name with non-alphanumerics stripped.
 * Returns matched agents in mention order, deduped.
 */
function resolveMentions<A extends AgentMatchable>(
  content: string,
  memberAgents: readonly A[],
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

/**
 * Find agents whose normalized full name appears as a substring in
 * the normalized message. Used for `Alice's team, draft a plan` style
 * addressing where there's no `@`.
 *
 * Required min length 4 (so a single-letter agent name can't match
 * accidentally on the article "a"). Skips matches that are also
 * substrings of any room human's name to avoid "alice" → Alice's team
 * when the speaker means Alice the human.
 */
function matchAgentsByName<A extends AgentMatchable>(
  content: string,
  memberAgents: readonly A[],
): A[] {
  const norm = normalize(content);
  const out: A[] = [];
  const seen = new Set<string>();
  for (const a of memberAgents) {
    const an = normalize(a.name);
    if (an.length < 4) continue;
    if (!norm.includes(an)) continue;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
