import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import { agentId, personId, sessionEventId, sessionId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresSessionEventRepository } from "./session-event-repo.js";
import { PostgresSessionRepository } from "./session-repo.js";

describe("PostgresSessionEventRepository", () => {
  let pool: Pool;
  let eventRepo: PostgresSessionEventRepository;
  let sessions: PostgresSessionRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let agent: string;
  let session: string;

  beforeAll(() => {
    pool = createTestPool();
    eventRepo = new PostgresSessionEventRepository(pool);
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
    session = (await newSession()).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  const newSession = () =>
    sessions.create({
      id: sessionId(),
      agent_id: agent,
      type: "task",
      intent: "do the thing",
    });

  async function lastEventAt(id: string): Promise<Date | null> {
    const { rows } = await pool.query<{ last_event_at: Date | null }>(
      `SELECT last_event_at FROM session WHERE id = $1`,
      [id],
    );
    return rows[0]?.last_event_at ?? null;
  }

  it("append round-trips the row and leaves tool_name undefined when omitted", async () => {
    const id = sessionEventId();
    const created = await eventRepo.append({
      id,
      session_id: session,
      kind: "agent",
      content: "thinking out loud",
    });

    expect(created.id).toBe(id);
    expect(created.session_id).toBe(session);
    expect(created.kind).toBe("agent");
    expect(created.content).toBe("thinking out loud");
    // null in the column surfaces as undefined on the domain object.
    expect(created.tool_name).toBeUndefined();
    expect(created.created_at).toBeInstanceOf(Date);
  });

  it("append preserves tool_name for tool_call / tool_result kinds", async () => {
    const call = await eventRepo.append({
      id: sessionEventId(),
      session_id: session,
      kind: "tool_call",
      content: '{"path":"README.md"}',
      tool_name: "Read",
    });
    expect(call.kind).toBe("tool_call");
    expect(call.tool_name).toBe("Read");

    const result = await eventRepo.append({
      id: sessionEventId(),
      session_id: session,
      kind: "tool_result",
      content: "# Beevibe",
      tool_name: "Read",
    });
    expect(result.tool_name).toBe("Read");
  });

  it("append bumps session.last_event_at — the orphan reaper depends on it", async () => {
    // A fresh session row has no last_event_at; without the CTE's UPDATE
    // every running session would look orphaned forever.
    expect(await lastEventAt(session)).toBeNull();

    await eventRepo.append({
      id: sessionEventId(),
      session_id: session,
      kind: "agent",
      content: "first",
    });
    const first = await lastEventAt(session);
    expect(first).toBeInstanceOf(Date);

    await new Promise((r) => setTimeout(r, 10));
    await eventRepo.append({
      id: sessionEventId(),
      session_id: session,
      kind: "agent",
      content: "second",
    });
    const second = await lastEventAt(session);
    expect(second!.getTime()).toBeGreaterThan(first!.getTime());
  });

  it("append only touches the target session's last_event_at", async () => {
    const other = await newSession();
    await eventRepo.append({
      id: sessionEventId(),
      session_id: session,
      kind: "agent",
      content: "x",
    });
    expect(await lastEventAt(other.id)).toBeNull();
  });

  it("append rejects an unknown session_id (FK) without inserting", async () => {
    await expect(
      eventRepo.append({
        id: sessionEventId(),
        session_id: "sess_nobody",
        kind: "agent",
        content: "orphan",
      }),
    ).rejects.toThrow();
    expect(await eventRepo.listBySession("sess_nobody")).toEqual([]);
  });

  it("listBySession returns events oldest first and scopes to the session", async () => {
    const ids: string[] = [];
    for (const content of ["one", "two", "three"]) {
      const ev = await eventRepo.append({
        id: sessionEventId(),
        session_id: session,
        kind: "agent",
        content,
      });
      ids.push(ev.id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const other = await newSession();
    await eventRepo.append({
      id: sessionEventId(),
      session_id: other.id,
      kind: "agent",
      content: "not mine",
    });

    const list = await eventRepo.listBySession(session);
    expect(list.map((e) => e.id)).toEqual(ids);
    expect(list.map((e) => e.content)).toEqual(["one", "two", "three"]);
    expect(await eventRepo.listBySession(other.id)).toHaveLength(1);
  });

  it("listBySession honors an explicit limit", async () => {
    for (const content of ["a", "b", "c"]) {
      await eventRepo.append({
        id: sessionEventId(),
        session_id: session,
        kind: "agent",
        content,
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    const limited = await eventRepo.listBySession(session, 2);
    expect(limited.map((e) => e.content)).toEqual(["a", "b"]);
  });
});
