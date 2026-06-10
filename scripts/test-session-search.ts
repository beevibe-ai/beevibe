/**
 * E2E smoke for session_search (Layer-3 memory).
 *
 * Targets the *dev* DB (DATABASE_URL) — same DB the running `pnpm dev`
 * api+scheduler are connected to. Exercises the live PostgresSession-
 * SearchRepository + SessionSearchService + createSessionSearchTool
 * against realistic transcript data and asserts:
 *
 *   1. Discovery finds the right conversations and returns bookends +
 *      ±5 message windows.
 *   2. Lineage dedupe collapses multi-turn chats to one hit.
 *   3. Scope is auto-resolved from the caller's hierarchy_level —
 *      an IC caller sees only their own sessions; a team caller sees
 *      themselves + their subordinates.
 *   4. Filters (status, session_type, task_id) narrow correctly.
 *   5. Scroll widens a known hit; read dumps a whole conversation;
 *      browse lists recent activity.
 *   6. The MCP tool wrapper's shape inference matches the underlying
 *      service contract.
 *
 * Usage:
 *   pnpm tsx scripts/test-session-search.ts
 *
 * Idempotent: fixtures are deterministically prefixed (`e2e_ss_`) and
 * cleaned up at the end. Doesn't touch any production-shape data.
 */

import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env") });

import {
  PostgresAgentRepository,
  PostgresPersonRepository,
  PostgresSessionEventRepository,
  PostgresSessionRepository,
  PostgresSessionSearchRepository,
  PostgresTaskRepository,
  createPool,
} from "../packages/core/src/adapters/postgres/index.js";
import { DEFAULT_RUNTIME_CONFIG } from "../packages/core/src/domain/agent.js";
import {
  agentId as makeAgentId,
  personId as makePersonId,
  sessionEventId as makeEventId,
  sessionId as makeSessionId,
  taskId as makeTaskId,
} from "../packages/core/src/domain/ids.js";
import { SessionSearchService } from "../packages/core/src/services/session-search.js";
import { createSessionSearchTool } from "../packages/api/src/tools/session-search.js";

// ── Fixture prefix so cleanup is unambiguous ─────────────────────────
const TAG = "e2e_ss";

function logHeader(s: string) {
  console.log("\n\x1b[1m\x1b[36m" + s + "\x1b[0m");
}
function ok(s: string) {
  console.log("  \x1b[32m✓\x1b[0m " + s);
}
function fail(s: string): never {
  console.error("  \x1b[31m✗\x1b[0m " + s);
  throw new Error(s);
}
function assert(cond: unknown, msg: string) {
  if (!cond) fail(msg);
  else ok(msg);
}

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = createPool({ connectionString: url, max: 4 });

  const persons = new PostgresPersonRepository(pool);
  const agents = new PostgresAgentRepository(pool);
  const tasks = new PostgresTaskRepository(pool);
  const sessions = new PostgresSessionRepository(pool);
  const events = new PostgresSessionEventRepository(pool);
  const searchRepo = new PostgresSessionSearchRepository(pool);
  const service = new SessionSearchService(searchRepo, agents, sessions);

  // ── Cleanup any prior run ──────────────────────────────────────────
  await pool.query(`DELETE FROM session_event WHERE session_id IN (SELECT id FROM session WHERE id LIKE $1)`, [`%${TAG}%`]);
  await pool.query(`DELETE FROM session WHERE id LIKE $1`, [`%${TAG}%`]);
  await pool.query(`DELETE FROM task WHERE id LIKE $1`, [`%${TAG}%`]);
  await pool.query(`DELETE FROM agent WHERE id LIKE $1`, [`%${TAG}%`]);
  await pool.query(`DELETE FROM person WHERE id LIKE $1`, [`%${TAG}%`]);

  try {
    // ── Seed: one owner, two ICs under one team ─────────────────────
    logHeader("Seeding fixture topology");
    const ownerId = `person_${TAG}_${makePersonId().slice(0, 8)}`;
    await persons.create({ id: ownerId, name: "e2e session_search owner" });
    ok(`person ${ownerId}`);

    const teamAgentId = `agent_${TAG}_${makeAgentId().slice(0, 8)}_team`;
    await agents.create({
      id: teamAgentId,
      name: "team",
      owner_id: ownerId,
      hierarchy_level: "team",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    const aliceId = `agent_${TAG}_${makeAgentId().slice(0, 8)}_alice`;
    await agents.create({
      id: aliceId,
      name: "alice",
      owner_id: ownerId,
      hierarchy_level: "ic",
      parent_agent_id: teamAgentId,
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    const bobId = `agent_${TAG}_${makeAgentId().slice(0, 8)}_bob`;
    await agents.create({
      id: bobId,
      name: "bob",
      owner_id: ownerId,
      hierarchy_level: "ic",
      parent_agent_id: teamAgentId,
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    ok(`team ${teamAgentId} with ICs alice + bob`);

    // ── Seed sessions: realistic mix ────────────────────────────────
    logHeader("Seeding sessions with realistic transcripts");

    // 1) Alice's failed auth refactor task — the "find the failed session" hit.
    const aliceTaskId = `task_${TAG}_${makeTaskId().slice(0, 8)}_authrefactor`;
    await tasks.create({
      id: aliceTaskId,
      title: "Refactor authentication middleware",
      priority: "high",
      creator_id: ownerId,
      creator_type: "person",
    });
    const aliceFailedSession = `sess_${TAG}_${makeSessionId().slice(0, 8)}_authfail`;
    await sessions.create({
      id: aliceFailedSession,
      agent_id: aliceId,
      task_id: aliceTaskId,
      type: "task",
      status: "failed",
      intent:
        "Refactor the authentication middleware to use the new JWT library — the old session-token flow needs to go.",
    });
    await events.append({
      id: makeEventId(),
      session_id: aliceFailedSession,
      kind: "agent",
      content:
        "Starting by mapping every call site of the old session-token middleware. I'll grep for setAuthCookie and parseAuthToken.",
      tool_name: undefined,
    });
    await sleep(5);
    await events.append({
      id: makeEventId(),
      session_id: aliceFailedSession,
      kind: "agent",
      content:
        "Found 23 call sites across packages/api and packages/web. About to start migrating one route at a time.",
      tool_name: undefined,
    });
    await sleep(5);
    await events.append({
      id: makeEventId(),
      session_id: aliceFailedSession,
      kind: "agent",
      content:
        "Hit a snag: the JWT library's verify() throws on expired tokens, but the existing middleware silently returns null. Going to need a wrapper.",
      tool_name: undefined,
    });
    await sleep(5);
    await events.append({
      id: makeEventId(),
      session_id: aliceFailedSession,
      kind: "agent",
      content:
        "Test suite is failing in unexpected places — looks like several integration tests assume the old auth shape. Blocking on user direction.",
      tool_name: undefined,
    });
    ok(`alice failed task session ${aliceFailedSession}`);

    // 2) Alice's earlier chat thread (multi-turn) about docker setup.
    const turn1 = `sess_${TAG}_${makeSessionId().slice(0, 8)}_dock1`;
    await sessions.create({
      id: turn1,
      agent_id: aliceId,
      type: "chat",
      intent: "Can you walk me through getting docker compose running locally?",
    });
    await events.append({
      id: makeEventId(),
      session_id: turn1,
      kind: "agent",
      content:
        "Sure — first make sure Docker Desktop is open. Then `docker compose up -d postgres` from the repo root.",
      tool_name: undefined,
    });
    await sleep(5);
    const turn2 = `sess_${TAG}_${makeSessionId().slice(0, 8)}_dock2`;
    await sessions.create({
      id: turn2,
      agent_id: aliceId,
      type: "chat",
      intent: "Docker says ECONNREFUSED on port 5433. Why?",
      prior_session_id: turn1,
    });
    await events.append({
      id: makeEventId(),
      session_id: turn2,
      kind: "agent",
      content:
        "That port is the test database (DATABASE_URL_TEST). Container is probably still starting — wait for `pg_isready -U beevibe` to succeed.",
      tool_name: undefined,
    });
    await sleep(5);
    ok(`alice docker chat (2-turn chain ${turn1} → ${turn2})`);

    // 3) Bob's succeeded billing refactor task — confounder for the
    //    discover filter test (also mentions "refactor").
    const bobTaskId = `task_${TAG}_${makeTaskId().slice(0, 8)}_billing`;
    await tasks.create({
      id: bobTaskId,
      title: "Refactor billing calculator",
      priority: "medium",
      creator_id: ownerId,
      creator_type: "person",
    });
    const bobSession = `sess_${TAG}_${makeSessionId().slice(0, 8)}_billing`;
    await sessions.create({
      id: bobSession,
      agent_id: bobId,
      task_id: bobTaskId,
      type: "task",
      status: "succeeded",
      intent: "Refactor the billing calculator to handle tiered pricing.",
    });
    await events.append({
      id: makeEventId(),
      session_id: bobSession,
      kind: "agent",
      content:
        "Pulled out the calculator into its own module and added unit tests for the new tier boundary cases.",
      tool_name: undefined,
    });
    ok(`bob succeeded billing task ${bobSession}`);

    // 4) An active session for alice — used as the exclude-lineage test.
    const activeSid = `sess_${TAG}_${makeSessionId().slice(0, 8)}_active`;
    await sessions.create({
      id: activeSid,
      agent_id: aliceId,
      type: "chat",
      intent: "Active conversation we should not re-discover via session_search.",
    });
    ok(`alice active session ${activeSid}`);

    // ── Tests ───────────────────────────────────────────────────────

    logHeader("Discovery — ic scope finds own auth refactor");
    const discAliceAuth = await service.search(
      { kind: "discover", query: "authentication middleware" },
      { callerAgentId: aliceId, hierarchyLevel: "ic", currentSessionId: activeSid },
    );
    assert(discAliceAuth?.kind === "discover", "shape is discover");
    assert(
      discAliceAuth?.kind === "discover" && discAliceAuth.hits.length >= 1,
      `≥1 hit (got ${(discAliceAuth as { hits: unknown[] }).hits.length})`,
    );
    if (discAliceAuth?.kind === "discover") {
      const hit = discAliceAuth.hits[0]!;
      assert(hit.session.session_id === aliceFailedSession, "matched session is the failed auth session");
      assert(typeof hit.snippet === "string" && hit.snippet.length > 0, `snippet present: "${hit.snippet}"`);
      assert(hit.bookend_start.length > 0, "bookend_start present");
      assert(hit.messages.some((m) => m.anchor), "anchor message flagged in window");
    }

    logHeader("Discovery — failed status filter narrows correctly");
    const discFailed = await service.search(
      {
        kind: "discover",
        query: "refactor",
        filters: { status: "failed" },
      },
      { callerAgentId: teamAgentId, hierarchyLevel: "team", currentSessionId: activeSid },
    );
    if (discFailed?.kind === "discover") {
      const everyHitFailed = discFailed.hits.every((h) => h.session.status === "failed");
      assert(everyHitFailed, `all ${discFailed.hits.length} hits have status=failed`);
      assert(
        discFailed.hits.some((h) => h.session.session_id === aliceFailedSession),
        "alice's failed auth session is included for team caller",
      );
    } else {
      fail("discovery returned non-discover shape");
    }

    logHeader("Discovery — team scope sees subordinate (bob), ic scope does NOT");
    const discTeamBilling = await service.search(
      { kind: "discover", query: "billing tiered" },
      { callerAgentId: teamAgentId, hierarchyLevel: "team", currentSessionId: activeSid },
    );
    assert(
      discTeamBilling?.kind === "discover" &&
        discTeamBilling.hits.some((h) => h.session.session_id === bobSession),
      "team caller can discover bob's billing session",
    );
    const discAliceBilling = await service.search(
      { kind: "discover", query: "billing tiered" },
      { callerAgentId: aliceId, hierarchyLevel: "ic", currentSessionId: activeSid },
    );
    assert(
      discAliceBilling?.kind === "discover" && discAliceBilling.hits.length === 0,
      "ic caller alice cannot see bob's billing session",
    );

    logHeader("Discovery — chat dedupe by conversation lineage");
    const discDocker = await service.search(
      { kind: "discover", query: "docker" },
      { callerAgentId: aliceId, hierarchyLevel: "ic", currentSessionId: activeSid },
    );
    if (discDocker?.kind === "discover") {
      assert(
        discDocker.hits.length === 1,
        `two-turn docker chat dedupes to 1 hit (got ${discDocker.hits.length})`,
      );
      assert(
        discDocker.hits[0]!.session.conversation_id === turn1,
        "lineage root resolves to first turn",
      );
    }

    logHeader("Discovery — excludes the caller's active lineage");
    const discActive = await service.search(
      { kind: "discover", query: "Active conversation" },
      { callerAgentId: aliceId, hierarchyLevel: "ic", currentSessionId: activeSid },
    );
    assert(
      discActive?.kind === "discover" && discActive.hits.length === 0,
      "active conversation is excluded from discovery",
    );

    logHeader("Read — full conversation dump");
    const readResult = await service.search(
      { kind: "read", session_id: aliceFailedSession },
      { callerAgentId: aliceId, hierarchyLevel: "ic", currentSessionId: activeSid },
    );
    assert(readResult?.kind === "read", "shape is read");
    if (readResult?.kind === "read") {
      assert(readResult.message_count === 5, `5 messages (1 intent + 4 agent), got ${readResult.message_count}`);
      assert(!readResult.truncated, "not truncated");
    }

    logHeader("Scroll — widen around a discovery anchor");
    const discAgain = await service.search(
      { kind: "discover", query: "authentication middleware" },
      { callerAgentId: aliceId, hierarchyLevel: "ic", currentSessionId: activeSid },
    );
    if (discAgain?.kind === "discover" && discAgain.hits.length > 0) {
      const hit = discAgain.hits[0]!;
      const scrollResult = await service.search(
        {
          kind: "scroll",
          session_id: hit.session.session_id,
          around_message_id: hit.match_message_id,
          window: 20,
        },
        { callerAgentId: aliceId, hierarchyLevel: "ic", currentSessionId: activeSid },
      );
      assert(scrollResult?.kind === "scroll", "shape is scroll");
      if (scrollResult?.kind === "scroll") {
        assert(scrollResult.messages.some((m) => m.anchor), "anchor flagged");
      }
    }

    logHeader("Browse — recent sessions in scope (deduped by lineage)");
    const browseAlice = await service.search(
      { kind: "browse", limit: 10 },
      { callerAgentId: aliceId, hierarchyLevel: "ic", currentSessionId: activeSid },
    );
    if (browseAlice?.kind === "browse") {
      const ids = browseAlice.sessions.map((s) => s.session_id);
      assert(ids.includes(aliceFailedSession), "browse surfaces alice's task session");
      assert(
        ids.filter((id) => id === turn1 || id === turn2).length <= 1,
        "browse dedupes the docker chat turns",
      );
      assert(!ids.includes(activeSid), "browse excludes active session");
      assert(!ids.includes(bobSession), "browse honors ic scope (no bob)");
    }

    logHeader("Filters — agent_id outside scope is rejected");
    try {
      await service.search(
        {
          kind: "discover",
          query: "anything",
          filters: { agent_id: bobId },
        },
        { callerAgentId: aliceId, hierarchyLevel: "ic", currentSessionId: activeSid },
      );
      fail("expected SessionSearchError for out-of-scope agent_id");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(/scope/.test(msg), `error mentions scope: "${msg}"`);
    }

    logHeader("MCP tool wrapper — shape inference + scope wired");
    const tool = createSessionSearchTool(
      { agentId: aliceId, hierarchyLevel: "ic", sessionId: activeSid },
      { sessionSearch: service },
    );
    const toolDiscover = await tool.handler({ query: "authentication middleware" });
    assert(!toolDiscover.isError, "discovery via MCP tool is not an error");
    assert(
      (toolDiscover.content as { kind?: string }).kind === "discover",
      "tool returned discover shape",
    );
    const toolForbidden = await tool.handler({ query: "x", filters: { agent_id: bobId } });
    assert(toolForbidden.isError === true, "out-of-scope agent_id is reported as tool error");
    assert(
      (toolForbidden.content as { error?: string }).error === "forbidden_agent_filter",
      "error code is forbidden_agent_filter",
    );

    logHeader("ALL ASSERTIONS PASSED");
  } finally {
    // ── Cleanup ─────────────────────────────────────────────────────
    logHeader("Cleaning up fixtures");
    await pool.query(`DELETE FROM session_event WHERE session_id IN (SELECT id FROM session WHERE id LIKE $1)`, [`%${TAG}%`]);
    await pool.query(`DELETE FROM session WHERE id LIKE $1`, [`%${TAG}%`]);
    await pool.query(`DELETE FROM task WHERE id LIKE $1`, [`%${TAG}%`]);
    await pool.query(`DELETE FROM agent WHERE id LIKE $1`, [`%${TAG}%`]);
    await pool.query(`DELETE FROM person WHERE id LIKE $1`, [`%${TAG}%`]);
    ok("fixtures deleted");
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
