import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import {
  agentId,
  personId,
  sessionEventId,
  sessionId,
} from "../../domain/ids.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import type { Pool } from "./client.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresSessionEventRepository } from "./session-event-repo.js";
import { PostgresSessionRepository } from "./session-repo.js";

describe("PostgresSessionEventRepository", () => {
  let pool: Pool;
  let events: PostgresSessionEventRepository;
  let sessions: PostgresSessionRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let agent: string;

  beforeAll(() => {
    pool = createTestPool();
    events = new PostgresSessionEventRepository(pool);
    sessions = new PostgresSessionRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const p = await persons.create({ id: personId(), name: "P" });
    const a = await agents.create({
      id: agentId(),
      name: "A",
      owner_id: p.id,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    agent = a.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function makeSession(): Promise<string> {
    const sid = sessionId();
    await sessions.create({
      id: sid,
      agent_id: agent,
      type: "chat",
      status: "running",
      intent: "x",
    });
    return sid;
  }

  async function seedEvents(sessionId: string, n: number, gapMs = 2): Promise<void> {
    for (let i = 0; i < n; i++) {
      await events.append({
        id: sessionEventId(),
        session_id: sessionId,
        kind: i % 2 === 0 ? "tool_call" : "tool_result",
        content: `e${i}`,
        tool_name: i % 2 === 0 ? "Bash" : undefined,
      });
      if (i < n - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
  }

  describe("listForSessions", () => {
    // Used by GET /chat and (planned) GET /room/:id to attach the
    // intermediate-step transcript to each agent message without firing
    // N+1 per-session queries. Single batched query; per-session cap.

    it("returns an empty map when no session ids are given", async () => {
      const out = await events.listForSessions([]);
      expect(out.size).toBe(0);
    });

    it("returns an empty array for sessions that have no events", async () => {
      const sid = await makeSession();
      const out = await events.listForSessions([sid]);
      expect(out.get(sid)).toEqual([]);
    });

    it("groups events by session_id with each group sorted oldest first", async () => {
      const s1 = await makeSession();
      const s2 = await makeSession();
      await seedEvents(s1, 3);
      await seedEvents(s2, 2);

      const out = await events.listForSessions([s1, s2]);

      const c1 = out.get(s1)?.map((e) => e.content) ?? [];
      const c2 = out.get(s2)?.map((e) => e.content) ?? [];
      expect(c1).toEqual(["e0", "e1", "e2"]);
      expect(c2).toEqual(["e0", "e1"]);
    });

    it("caps events per session at limitPerSession, keeping the MOST RECENT N", async () => {
      // Regression guard: a naive global LIMIT would drop late events
      // on a chatty session in favor of early events on a quiet one.
      // The implementation must rank per-session and keep the tail.
      const s1 = await makeSession();
      const s2 = await makeSession();
      await seedEvents(s1, 5);
      await seedEvents(s2, 1);

      const out = await events.listForSessions([s1, s2], 3);

      expect(out.get(s1)?.map((e) => e.content)).toEqual(["e2", "e3", "e4"]);
      expect(out.get(s2)?.map((e) => e.content)).toEqual(["e0"]);
    });

    it("ignores session ids that don't exist (no rows returned, but the key is present)", async () => {
      const real = await makeSession();
      await seedEvents(real, 1);
      const out = await events.listForSessions([real, "sess_nope"]);
      expect(out.get(real)).toHaveLength(1);
      expect(out.get("sess_nope")).toEqual([]);
    });
  });
});
