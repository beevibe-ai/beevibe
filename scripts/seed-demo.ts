#!/usr/bin/env node
/**
 * `pnpm seed-demo` — populate the dev DB with realistic demo data.
 *
 * Additive: existing rows are kept. Re-runs are idempotent for persons +
 * team agents (looked up by email / owner). Other entities (tasks, facts,
 * sessions, mesh rows, room messages) accumulate; titles are prefixed
 * `[seed]` so the user can spot what came from this script.
 *
 * Cost: ~64 memory_fact rows × ~30 tokens via OpenAI text-embedding-3-small
 * ≈ 2k tokens ≈ $0.00004 per run.
 */

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
loadDotenv({ path: join(REPO_ROOT, ".env") });

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

// Re-target to existing personas (whose API keys are already provisioned + remembered).
// `name` is what we'd use to create them if missing — existing rows match by email,
// keeping their original display name regardless.
const WEIJIA_NAME = "weijia";

interface PersonaSpec {
  name: string;
  email: string;
  teamLabel: string;
  ics: Array<{ name: string; focus: string }>;
}

const PERSONAS: PersonaSpec[] = [
  {
    name: WEIJIA_NAME,
    email: "songweijia2001@gmail.com",
    teamLabel: "weijia's team",
    ics: [
      { name: "backend specialist", focus: "API, postgres, mesh internals" },
      { name: "infra specialist", focus: "deploy, observability, tunnels" },
      { name: "data specialist", focus: "embeddings, recall, vector search" },
    ],
  },
  {
    name: "Daniel",
    email: "daniel@example.com",
    teamLabel: "Daniel's team",
    ics: [
      { name: "product specialist", focus: "scoping, customer intent, briefs" },
      { name: "research specialist", focus: "discovery, competitive recon" },
      { name: "roadmap specialist", focus: "milestone planning, risk burn-down" },
    ],
  },
  {
    name: "bob",
    email: "bob@example.com",
    teamLabel: "bob's team",
    ics: [
      { name: "frontend specialist", focus: "Next.js, React Query, SSE wiring" },
      { name: "mobile specialist", focus: "iOS shell, push, deeplinks" },
      { name: "qa specialist", focus: "regression sweeps, demo smoke tests" },
    ],
  },
  {
    name: "Carol Wright",
    email: "carol@beevibe.dev",
    teamLabel: "Carol's team",
    ics: [
      { name: "visual specialist", focus: "type, color, layout density" },
      { name: "motion specialist", focus: "transitions, perceived perf" },
      { name: "ux specialist", focus: "flows, copy, empty states" },
    ],
  },
];

interface FactSeed {
  scope: "ic" | "team" | "org";
  fact_type: "belief" | "pattern" | "gotcha" | "preference" | "decision";
  content: string;
}

const FACTS_BY_FOCUS: Record<string, FactSeed[]> = {
  "API, postgres, mesh internals": [
    { scope: "ic", fact_type: "gotcha", content: "Express middleware mount-order: streamRouter must mount before viewRouter or `?token=` SSE requests get eaten by the Bearer-only auth guard." },
    { scope: "ic", fact_type: "pattern", content: "Use pg_notify('bv_event', ...) from triggers; SseListener fans out via OwnerLookup → SseManager." },
    { scope: "team", fact_type: "decision", content: "Per-user SSE filtering resolves owner_person_id at fanout time so multi-tenant rooms reach every member." },
    { scope: "ic", fact_type: "preference", content: "Prefer prepared statements with $1::vector casts when inserting embeddings; pgvector silently rejects raw arrays." },
  ],
  "deploy, observability, tunnels": [
    { scope: "ic", fact_type: "gotcha", content: "Cloudflared trycloudflare quick tunnels buffer SSE; switch to --protocol http2 and let the web fall back to 3s polling." },
    { scope: "ic", fact_type: "pattern", content: "dev.sh writes the api tunnel URL to .env.local, then spawns web with explicit NEXT_PUBLIC_BV_API_URL so the bundle has the right origin." },
    { scope: "team", fact_type: "decision", content: "Network drops UDP/QUIC; default cloudflared transport is http2 for this workstation." },
    { scope: "ic", fact_type: "belief", content: "If `pkill` returns 1 under set -e, the script aborts; always append `|| true`." },
  ],
  "embeddings, recall, vector search": [
    { scope: "ic", fact_type: "pattern", content: "OpenAIEmbeddingService.embedBatch handles up to 2048 inputs/request; batch seed writes." },
    { scope: "ic", fact_type: "gotcha", content: "memory_fact.embedding is VECTOR(1536) NOT NULL — every fact needs a real or deterministic vector at insert time." },
    { scope: "team", fact_type: "decision", content: "FactStore.addOrMerge dedups near-duplicate IC-scope observations above 0.92 cosine via LLM merge." },
    { scope: "ic", fact_type: "preference", content: "HNSW index on memory_fact(embedding vector_cosine_ops) is the right default for our recall sizes." },
  ],
  "scoping, customer intent, briefs": [
    { scope: "ic", fact_type: "belief", content: "A good brief names the user, the moment of pain, and the proof we'd accept that the fix worked." },
    { scope: "team", fact_type: "preference", content: "We don't add 'admin dashboards' before there's a user who can articulate what decision they'd make from one." },
    { scope: "ic", fact_type: "pattern", content: "When a customer says 'just add a button', restate the underlying job-to-be-done before agreeing." },
    { scope: "org", fact_type: "decision", content: "Demo flow always shows two humans + their team agents collaborating — never a single-user surface." },
  ],
  "discovery, competitive recon": [
    { scope: "ic", fact_type: "belief", content: "Most agent products today are single-user prompt boxes; the multi-tenant 'agents collaborate' angle is uncrowded." },
    { scope: "ic", fact_type: "pattern", content: "Search GitHub for 'mcp-server-*' to surface the long tail of tools competitors are integrating with." },
    { scope: "team", fact_type: "gotcha", content: "Don't confuse 'Claude Code as IDE assistant' with 'Claude Code as agent runtime' in pitch material — the audiences differ." },
  ],
  "milestone planning, risk burn-down": [
    { scope: "ic", fact_type: "preference", content: "Sequence M8 follow-ups by blast radius: route-only first (POST /task, kill /threads), then data-display split (dashboard/mesh), then schema (promotion audit)." },
    { scope: "team", fact_type: "decision", content: "M8.2 read surface ships data-only DTOs; web composes display-shaped output via mappers." },
    { scope: "ic", fact_type: "gotcha", content: "Promotion audit table relaxes the 'no core changes in M8.2' rule — flag explicitly before starting." },
  ],
  "Next.js, React Query, SSE wiring": [
    { scope: "ic", fact_type: "gotcha", content: "Auto-signed-in surprise on remote PCs: NEXT_PUBLIC_BV_USER_KEY in shell env leaks into the bundle. Pass an explicit empty value on web spawn." },
    { scope: "ic", fact_type: "pattern", content: "useLiveUpdates + 3s polling refetchInterval is the floor; SSE is fast-path. Components never need to choose." },
    { scope: "team", fact_type: "decision", content: "react-markdown + remark-gfm scoped under .chat-md; agent messages render markdown, human messages don't." },
    { scope: "ic", fact_type: "preference", content: "Optimistic updates use onMutate/onSuccess/onError rollback; never let a mutation gap show empty state." },
  ],
  "iOS shell, push, deeplinks": [
    { scope: "ic", fact_type: "belief", content: "Mobile shell is mostly a deeplink target into web; native chrome only where push or biometric matters." },
    { scope: "ic", fact_type: "pattern", content: "Universal links route /rooms/:id and /tasks/:id to the right detail page; everything else falls through to /home." },
    { scope: "team", fact_type: "gotcha", content: "iOS Safari treats text/event-stream as a download under some shipping configs — verify on physical device, not simulator." },
  ],
  "regression sweeps, demo smoke tests": [
    { scope: "ic", fact_type: "pattern", content: "Demo smoke: two browsers, sign in as Weijia + Daniel, open same room, send 'team, status?' from each side, watch typing indicators bloom." },
    { scope: "ic", fact_type: "gotcha", content: "If the typing bubble never resolves, check listRunningInRoom — a stuck running session masks the next turn." },
    { scope: "team", fact_type: "decision", content: "Pre-demo checklist runs `pnpm typecheck && pnpm build` plus a real end-to-end room round-trip; no shortcuts." },
  ],
  "type, color, layout density": [
    { scope: "ic", fact_type: "preference", content: "Tier information by importance — flat property lists at equal weight read as 'I haven't decided what matters'." },
    { scope: "team", fact_type: "decision", content: "Dense layouts use 12px / 14px scale with a 4-column property grid; never break density with stray 16px gaps." },
    { scope: "ic", fact_type: "pattern", content: "Color-code task status with a single-channel ramp; let priority + age fight for the second visual axis." },
  ],
  "transitions, perceived perf": [
    { scope: "ic", fact_type: "belief", content: "200ms is the perceived-instant threshold; agent responses that stream within that window feel native." },
    { scope: "ic", fact_type: "pattern", content: "Skeleton-then-content is fine; skeleton-then-flash-empty-then-content is worse than just blocking." },
    { scope: "team", fact_type: "preference", content: "Typing indicators must show *what* the agent is doing (tool name + arg preview), not just three dots." },
  ],
  "flows, copy, empty states": [
    { scope: "ic", fact_type: "preference", content: "Empty states name the next action concretely — 'Mention @weijia-team to start' beats 'No messages yet'." },
    { scope: "ic", fact_type: "gotcha", content: "Suggested-action chips that don't pre-fill the addressee route to nobody; always prepend @<short_id> from the sender." },
    { scope: "team", fact_type: "decision", content: "Onboarding never asks a generic 'tell me about your team' question — it spawns specialists from the cold-start codebase." },
  ],
};

interface TaskSeed {
  title: string;
  description: string;
  status: "pending" | "assigned" | "in_progress" | "review" | "blocked" | "done";
  priority: "low" | "medium" | "high" | "critical";
  assigneeFocus: string;
  creatorPersona: string;
  resultSummary?: string;
  blockerReason?: string;
  blockerOwnerFocus?: string;
}

const TASK_SEEDS: TaskSeed[] = [
  { title: "Wire memory_fact HNSW recall into briefing", description: "Pull top-K facts by cosine similarity into MemoryAgent.prepareBriefing.", status: "done", priority: "high", assigneeFocus: "embeddings, recall, vector search", creatorPersona: WEIJIA_NAME, resultSummary: "Top-5 facts injected; briefing token budget held under 2k." },
  { title: "Land /room SSE fanout", description: "Stream room.message events to every member, not just the owner.", status: "done", priority: "high", assigneeFocus: "API, postgres, mesh internals", creatorPersona: WEIJIA_NAME, resultSummary: "OwnerLookup walks room_id → room_member.person_id; verified across two browsers." },
  { title: "Cloudflared http2 fallback", description: "QUIC dropped on this network; switch dev.sh to http2 and document.", status: "done", priority: "medium", assigneeFocus: "deploy, observability, tunnels", creatorPersona: WEIJIA_NAME, resultSummary: "Tunnels stable for >2h; no more 'stream canceled' spam." },
  { title: "Vocative-aware addressee resolution", description: "'team, ...' should fire speaker's team; 'bob:' should fire Bob's team.", status: "done", priority: "high", assigneeFocus: "API, postgres, mesh internals", creatorPersona: "Daniel", resultSummary: "Vocative extracted before name-substring; six routing test cases pass." },
  { title: "Mock-fidelity sidebar pass", description: "Match Notion-style sidebar density and weight from comp.", status: "done", priority: "medium", assigneeFocus: "type, color, layout density", creatorPersona: "Carol Wright", resultSummary: "Shipped in #26; comp parity verified at 1x and 2x." },
  { title: "M8 dashboard data/display split", description: "Backend returns DashboardSummary (data only); web composes DashboardDisplay.", status: "in_progress", priority: "high", assigneeFocus: "Next.js, React Query, SSE wiring", creatorPersona: WEIJIA_NAME },
  { title: "/thread surface decision", description: "Kill the aspirational threads UI; remove sidebar entry, route, types.", status: "in_progress", priority: "low", assigneeFocus: "flows, copy, empty states", creatorPersona: "Carol Wright" },
  { title: "Memory promotion audit table", description: "Add memory_promotion_event; FactPromoter writes promoted + rejected decisions.", status: "in_progress", priority: "high", assigneeFocus: "embeddings, recall, vector search", creatorPersona: WEIJIA_NAME },
  { title: "Demo smoke checklist", description: "End-to-end room round-trip plus typecheck before every share-link.", status: "review", priority: "medium", assigneeFocus: "regression sweeps, demo smoke tests", creatorPersona: "bob" },
  { title: "iOS shell deeplink routing", description: "Universal links to /rooms/:id and /tasks/:id; fall through to /home.", status: "review", priority: "low", assigneeFocus: "iOS shell, push, deeplinks", creatorPersona: "bob" },
  { title: "Typing-indicator tool transcript", description: "Show agent's current tool + arg preview, not three dots.", status: "blocked", priority: "high", assigneeFocus: "transitions, perceived perf", creatorPersona: "Carol Wright", blockerReason: "Need session_event schema decision from backend before binding.", blockerOwnerFocus: "API, postgres, mesh internals" },
  { title: "Pricing competitive scan", description: "Where do per-seat agent products land vs ours?", status: "pending", priority: "medium", assigneeFocus: "discovery, competitive recon", creatorPersona: "Daniel" },
];

interface SessionSeed {
  taskTitle: string;
  intent: string;
  resultSummary: string;
  status: "succeeded" | "running";
  cliId: string;
}

const SESSION_SEEDS: SessionSeed[] = [
  { taskTitle: "Wire memory_fact HNSW recall into briefing", intent: "Pull top-K facts into briefing", resultSummary: "Top-5 facts injected; briefing token budget held under 2k.", status: "succeeded", cliId: "cli-recall-1" },
  { taskTitle: "Land /room SSE fanout", intent: "Fan out room.message to every member", resultSummary: "OwnerLookup updated; verified two-browser delivery.", status: "succeeded", cliId: "cli-fanout-1" },
  { taskTitle: "Cloudflared http2 fallback", intent: "Switch tunnel transport to http2", resultSummary: "dev.sh uses --protocol http2; tunnels stable.", status: "succeeded", cliId: "cli-cf-1" },
  { taskTitle: "Vocative-aware addressee resolution", intent: "Vocative-first routing for natural addressing", resultSummary: "Six routing cases verified.", status: "succeeded", cliId: "cli-vocative-1" },
  { taskTitle: "Mock-fidelity sidebar pass", intent: "Match Notion comp density", resultSummary: "Shipped in #26.", status: "succeeded", cliId: "cli-sidebar-1" },
  { taskTitle: "M8 dashboard data/display split", intent: "Land DashboardSummary + display mapper", resultSummary: "", status: "running", cliId: "cli-dash-1" },
];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL not set — run pnpm bootstrap first or source .env");
    process.exit(2);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY not set — needed for memory_fact embeddings");
    process.exit(2);
  }

  const {
    createPool,
    PostgresPersonRepository,
    PostgresAgentRepository,
    PostgresCoreMemoryRepository,
    PostgresTaskRepository,
    PostgresSessionRepository,
    PostgresMemoryFactRepository,
    PostgresMemoryPromotionEventRepository,
    PostgresNegotiationRepository,
    PostgresNegotiationRoundRepository,
    PostgresEscalationRepository,
    PostgresRoomRepository,
  } = await import("../packages/core/src/adapters/postgres/index.js");
  const { provisionAgent, provisionUser } = await import(
    "../packages/core/src/auth/provision.js"
  );
  const ids = await import("../packages/core/src/domain/ids.js");
  const { OpenAIEmbeddingService } = await import(
    "../packages/core/src/adapters/openai/embeddings.js"
  );

  const pool = createPool({ connectionString: databaseUrl });
  const personRepo = new PostgresPersonRepository(pool);
  const agentRepo = new PostgresAgentRepository(pool);
  const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
  const taskRepo = new PostgresTaskRepository(pool);
  const sessionRepo = new PostgresSessionRepository(pool);
  const factRepo = new PostgresMemoryFactRepository(pool);
  const promoRepo = new PostgresMemoryPromotionEventRepository(pool);
  const negRepo = new PostgresNegotiationRepository(pool);
  const negRoundRepo = new PostgresNegotiationRoundRepository(pool);
  const escRepo = new PostgresEscalationRepository(pool);
  const roomRepo = new PostgresRoomRepository(pool);
  const embed = new OpenAIEmbeddingService();

  type AgentLite = { id: string; name: string; owner_id: string; hierarchy_level: string };

  interface PersonaResolved {
    spec: PersonaSpec;
    personId: string;
    apiKey: string;
    teamAgent: AgentLite;
    icAgents: Map<string, AgentLite>; // focus → agent
  }

  try {
    // ── 1. Personas ────────────────────────────────────────────────────
    console.log(cyan("→") + " Resolving personas");
    const resolved: PersonaResolved[] = [];
    for (const spec of PERSONAS) {
      const existingPerson = await personRepo.findByEmail(spec.email);
      let personId: string;
      let apiKey: string;
      if (existingPerson?.api_key) {
        personId = existingPerson.id;
        apiKey = existingPerson.api_key;
        console.log(`  ${green("✓")} ${spec.name} ${dim(personId)} ${dim("(existing)")}`);
      } else {
        const result = await provisionUser(
          { personRepo },
          { id: ids.personId(), name: spec.name, email: spec.email },
        );
        personId = result.person.id;
        apiKey = result.apiKey;
        console.log(`  ${green("+")} ${spec.name} ${dim(personId)} ${dim("(new)")}`);
      }

      let teamAgent = await agentRepo.findTopLevelForOwner(personId);
      if (!teamAgent) {
        const created = await provisionAgent(
          { agentRepo, coreMemoryRepo },
          {
            id: ids.agentId(),
            name: spec.teamLabel,
            owner_id: personId,
            hierarchy_level: "team",
            runtime_config: { type: "claude-code" as const, model: "claude-opus-4-7" },
          },
        );
        teamAgent = created.agent;
        console.log(`    ${green("+")} team agent ${dim(teamAgent.id)} ${spec.teamLabel}`);
      }

      const subs = await agentRepo.findSubordinates(teamAgent.id);
      const icAgents = new Map<string, AgentLite>();
      for (const ic of spec.ics) {
        const existing = subs.find((a) => a.name === ic.name);
        if (existing) {
          icAgents.set(ic.focus, existing);
          continue;
        }
        const created = await provisionAgent(
          { agentRepo, coreMemoryRepo },
          {
            id: ids.agentId(),
            name: ic.name,
            owner_id: personId,
            parent_agent_id: teamAgent.id,
            hierarchy_level: "ic",
            runtime_config: { type: "claude-code" as const, model: "claude-opus-4-7" },
          },
        );
        icAgents.set(ic.focus, created.agent);
        console.log(`    ${green("+")} IC ${dim(created.agent.id)} ${ic.name}`);
      }

      resolved.push({ spec, personId, apiKey, teamAgent, icAgents });
    }

    const personaByName = new Map(resolved.map((r) => [r.spec.name, r] as const));
    const allAgents: AgentLite[] = resolved.flatMap((r) => [
      r.teamAgent,
      ...r.icAgents.values(),
    ]);
    const agentByFocus = new Map<string, AgentLite>();
    for (const r of resolved) for (const [focus, a] of r.icAgents) agentByFocus.set(focus, a);

    // ── 2. Tasks ───────────────────────────────────────────────────────
    console.log(cyan("→") + " Inserting tasks");
    const tasksByTitle = new Map<string, { id: string; assignee_id: string }>();
    for (const t of TASK_SEEDS) {
      const assignee = agentByFocus.get(t.assigneeFocus);
      const creator = personaByName.get(t.creatorPersona);
      if (!assignee || !creator) {
        console.warn(`  ${yellow("!")} skip ${t.title} (assignee/creator missing)`);
        continue;
      }
      const blocker = t.blockerOwnerFocus ? agentByFocus.get(t.blockerOwnerFocus) : undefined;
      const id = ids.taskId();
      await taskRepo.create({
        id,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        assignee_id: assignee.id,
        creator_id: creator.personId,
        creator_type: "person",
        result_summary: t.resultSummary,
        blocker_agent_id: blocker?.id,
        blocker_reason: t.blockerReason,
      });
      tasksByTitle.set(t.title, { id, assignee_id: assignee.id });
      console.log(`  ${green("+")} ${dim(id)} ${t.status.padEnd(11)} ${t.title}`);
    }

    // ── 3. Sessions ────────────────────────────────────────────────────
    console.log(cyan("→") + " Inserting sessions");
    const sessionsByTask = new Map<string, string>();
    const now = Date.now();
    for (const s of SESSION_SEEDS) {
      const task = tasksByTitle.get(s.taskTitle);
      if (!task) continue;
      const id = ids.sessionId();
      const startedAt = new Date(now - 1000 * 60 * 30);
      const completedAt = s.status === "succeeded" ? new Date(now - 1000 * 60 * 5) : undefined;
      const session = await sessionRepo.create({
        id,
        agent_id: task.assignee_id,
        task_id: task.id,
        type: "task",
        status: s.status,
        intent: s.intent,
        cli_session_id: s.cliId,
        result_summary: s.resultSummary || undefined,
        exit_code: s.status === "succeeded" ? 0 : undefined,
        started_at: startedAt,
        usage: { cost_usd: 0.04, input_tokens: 1200, output_tokens: 380, model: "claude-opus-4-7" },
      });
      if (completedAt) {
        await sessionRepo.update(session.id, { completed_at: completedAt });
      }
      sessionsByTask.set(s.taskTitle, id);
      console.log(`  ${green("+")} ${dim(id)} ${s.status.padEnd(9)} ${s.taskTitle}`);
    }

    // ── 4. Memory facts (with real OpenAI embeddings) ──────────────────
    console.log(cyan("→") + " Embedding + inserting memory facts");
    interface FactRow {
      id: string;
      agent_id: string;
      scope: "ic" | "team" | "org";
      fact_type: FactSeed["fact_type"];
      content: string;
      source_session_ids: string[];
    }
    const pendingFacts: FactRow[] = [];
    for (const r of resolved) {
      for (const ic of r.spec.ics) {
        const agent = r.icAgents.get(ic.focus);
        const facts = FACTS_BY_FOCUS[ic.focus];
        if (!agent || !facts) continue;
        for (const f of facts) {
          pendingFacts.push({
            id: ids.factId(),
            agent_id: agent.id,
            scope: f.scope,
            fact_type: f.fact_type,
            content: f.content,
            source_session_ids: [],
          });
        }
      }
    }
    const embeddings = await embed.embedBatch(pendingFacts.map((f) => f.content));
    const factsById = new Map<string, FactRow>();
    for (let i = 0; i < pendingFacts.length; i++) {
      const f = pendingFacts[i];
      const e = embeddings[i];
      if (!f || !e) continue;
      await factRepo.create({ ...f, embedding: e });
      factsById.set(f.id, f);
    }
    console.log(`  ${green("✓")} ${pendingFacts.length} facts inserted with real embeddings`);

    // ── 5. Promotion events (audit log) ────────────────────────────────
    console.log(cyan("→") + " Inserting promotion events");
    const promoCandidates = [...factsById.values()].filter((f) => f.scope === "team").slice(0, 4);
    const promoReasons = [
      "Recurring across multiple sessions; visibility benefit > scope cost.",
      "Pattern referenced by sibling agents; promote to team scope.",
      "Decision codified in code review; team-scope makes it discoverable.",
      "High-confidence preference shared by peers; widen visibility.",
    ];
    for (let i = 0; i < promoCandidates.length; i++) {
      const f = promoCandidates[i]!;
      await promoRepo.create({
        id: ids.promotionEventId(),
        fact_id: f.id,
        from_scope: "ic",
        to_scope: "team",
        origin_agent_id: f.agent_id,
        promoter_reason: promoReasons[i % promoReasons.length]!,
        source_session_ids: [],
        rejected: false,
      });
    }
    const rejectedCandidate = [...factsById.values()].find((f) => f.scope === "ic");
    if (rejectedCandidate) {
      await promoRepo.create({
        id: ids.promotionEventId(),
        fact_id: rejectedCandidate.id,
        from_scope: "ic",
        to_scope: "ic",
        origin_agent_id: rejectedCandidate.agent_id,
        promoter_reason: "Workstation-specific; not generalizable to team scope.",
        source_session_ids: [],
        rejected: true,
      });
    }
    console.log(`  ${green("✓")} ${promoCandidates.length + (rejectedCandidate ? 1 : 0)} promotion events`);

    // ── 6. Mesh: negotiation + escalation ──────────────────────────────
    console.log(cyan("→") + " Inserting negotiation + escalation");
    const weijiaBackend = personaByName.get(WEIJIA_NAME)?.icAgents.get("API, postgres, mesh internals");
    const danielRoadmap = personaByName.get("Daniel")?.icAgents.get("milestone planning, risk burn-down");
    const carolUx = personaByName.get("Carol Wright")?.icAgents.get("flows, copy, empty states");
    const bobFrontend = personaByName.get("bob")?.icAgents.get("Next.js, React Query, SSE wiring");

    if (weijiaBackend && danielRoadmap) {
      const initiatorSession = await sessionRepo.create({
        id: ids.sessionId(),
        agent_id: weijiaBackend.id,
        type: "mesh_negotiate",
        status: "succeeded",
        intent: "Negotiate M8 promotion-audit table scope with roadmap",
        started_at: new Date(now - 1000 * 60 * 90),
        result_summary: "Accepted: ship audit table behind M8.D issue.",
      });
      const counterpartySession = await sessionRepo.create({
        id: ids.sessionId(),
        agent_id: danielRoadmap.id,
        type: "mesh_negotiate",
        status: "succeeded",
        intent: "Counter on M8.D scope vs deferral",
        started_at: new Date(now - 1000 * 60 * 88),
        result_summary: "Accepted backend's scope after risk discussion.",
      });
      const negId = ids.negotiationId();
      await negRepo.create({
        id: negId,
        initiator_agent_id: weijiaBackend.id,
        initiator_session_id: initiatorSession.id,
        counterparty_agent_id: danielRoadmap.id,
        counterparty_session_id: counterpartySession.id,
        max_rounds: 5,
        rounds_completed: 3,
        status: "accepted",
      });
      const rounds = [
        { from: weijiaBackend.id, decision: "propose" as const, message: "Add memory_promotion_event behind M8.D; small schema, big audit win." },
        { from: danielRoadmap.id, decision: "counter" as const, message: "Defer to M9 — M8 was scoped no-core-changes." },
        { from: weijiaBackend.id, decision: "accept" as const, message: "Audit log is observability, not denormalization. Accepting your guardrail: separate PR, separate issue." },
      ];
      for (let i = 0; i < rounds.length; i++) {
        const r = rounds[i]!;
        await negRoundRepo.create({
          id: ids.negotiationRoundId(),
          negotiation_id: negId,
          round_number: i + 1,
          from_agent_id: r.from,
          decision: r.decision,
          message: r.message,
        });
      }
      console.log(`  ${green("+")} negotiation ${dim(negId)} (accepted, 3 rounds)`);
    }

    if (carolUx && bobFrontend) {
      const initiatorSession = await sessionRepo.create({
        id: ids.sessionId(),
        agent_id: carolUx.id,
        type: "mesh_negotiate",
        status: "succeeded",
        intent: "Negotiate empty-state copy direction",
        started_at: new Date(now - 1000 * 60 * 60),
        result_summary: "Could not converge; escalated to humans.",
      });
      const counterpartySession = await sessionRepo.create({
        id: ids.sessionId(),
        agent_id: bobFrontend.id,
        type: "mesh_negotiate",
        status: "succeeded",
        intent: "Counter on empty-state copy",
        started_at: new Date(now - 1000 * 60 * 58),
        result_summary: "Disagreed on call-to-action density; escalated.",
      });
      const negId = ids.negotiationId();
      await negRepo.create({
        id: negId,
        initiator_agent_id: carolUx.id,
        initiator_session_id: initiatorSession.id,
        counterparty_agent_id: bobFrontend.id,
        counterparty_session_id: counterpartySession.id,
        max_rounds: 5,
        rounds_completed: 4,
        status: "escalated",
      });
      const rounds = [
        { from: carolUx.id, decision: "propose" as const, message: "Empty state should name the next action, not describe the absence." },
        { from: bobFrontend.id, decision: "counter" as const, message: "We don't have addressee metadata at render time; can't pre-fill @short_id." },
        { from: carolUx.id, decision: "counter" as const, message: "Wire it through — typing-bubble already has sender_agent_id." },
        { from: bobFrontend.id, decision: "reject" as const, message: "Crosses the chat-stream boundary; needs a humans-call." },
      ];
      for (let i = 0; i < rounds.length; i++) {
        const r = rounds[i]!;
        await negRoundRepo.create({
          id: ids.negotiationRoundId(),
          negotiation_id: negId,
          round_number: i + 1,
          from_agent_id: r.from,
          decision: r.decision,
          message: r.message,
        });
      }
      await escRepo.create({
        id: ids.escalationId(),
        negotiation_id: negId,
        initiator_session_id: initiatorSession.id,
        counterparty_session_id: counterpartySession.id,
        summary: "Empty-state copy direction: pre-fill addressee metadata vs keep generic. Frontend says boundary crossing; UX says it's the only way to ship the chip-click flow.",
        initiator_proposals: { headline: "Empty states pre-fill @addressee", details: "Pull sender_agent_id into typing-bubble; prepend on chip click." },
        initiator_open_questions: ["Does this leak sender identity into stale caches?"],
        initiator_submitted_at: new Date(now - 1000 * 60 * 50),
        escalated_by_role: "initiator",
        status: "pending",
      });
      console.log(`  ${green("+")} negotiation ${dim(negId)} (escalated, 4 rounds)`);
    }

    // ── 7. Room: Weijia + Daniel + their team agents ───────────────────
    console.log(cyan("→") + " Creating demo room");
    const weijia = personaByName.get(WEIJIA_NAME)!;
    const daniel = personaByName.get("Daniel")!;
    const room = await roomRepo.create({
      id: ids.roomId(),
      name: "M8 launch readiness",
      owner_person_id: weijia.personId,
    });
    await roomRepo.addPersonMember(room.id, weijia.personId);
    await roomRepo.addPersonMember(room.id, daniel.personId);
    await roomRepo.addAgentMember(room.id, weijia.teamAgent.id);
    await roomRepo.addAgentMember(room.id, daniel.teamAgent.id);
    type SeedMsg =
      | { kind: "human"; sender_person_id: string; content: string }
      | { kind: "agent"; sender_agent_id: string; content: string };
    const messages: SeedMsg[] = [
      { kind: "human", sender_person_id: weijia.personId, content: "Daniel — where are we on M8 reads?" },
      { kind: "human", sender_person_id: daniel.personId, content: "Dashboard split landed. Mesh phase 1 in flight." },
      { kind: "agent", sender_agent_id: weijia.teamAgent.id, content: "Backend update: HNSW recall is live, fanout is verified across browsers, and the promotion audit table is being negotiated with roadmap." },
      { kind: "agent", sender_agent_id: daniel.teamAgent.id, content: "Roadmap take: scope on M8.D is acceptable as a separate PR. We held the line on no-core-changes within M8.2 itself." },
      { kind: "human", sender_person_id: weijia.personId, content: "team, what's the demo path through the room?" },
      { kind: "agent", sender_agent_id: weijia.teamAgent.id, content: "Two browsers, one room, send 'team, status?' from each side. Typing bubbles render the active tool. Vocative routing means 'team' fires the speaker's own team." },
    ];
    for (const m of messages) {
      await roomRepo.appendMessage({
        id: ids.roomMessageId(),
        room_id: room.id,
        kind: m.kind,
        sender_person_id: m.kind === "human" ? m.sender_person_id : undefined,
        sender_agent_id: m.kind === "agent" ? m.sender_agent_id : undefined,
        content: m.content,
      });
    }
    console.log(`  ${green("+")} room ${dim(room.id)} ${room.name}`);

    // ── Summary ────────────────────────────────────────────────────────
    console.log("\n" + bold("Seed complete."));
    console.log(dim("\nAPI keys (sign in at the web /sign-in page):"));
    for (const r of resolved) {
      console.log(`  ${r.spec.name.padEnd(20)} ${r.apiKey}`);
    }
    console.log(
      dim(
        "\nAgents: " +
          allAgents.length +
          ", facts: " +
          pendingFacts.length +
          ", tasks: " +
          tasksByTitle.size +
          ".",
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("seed-demo failed:", err);
  process.exit(1);
});
