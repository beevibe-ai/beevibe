/**
 * Rooms adapter — integration tests against beevibe_test.
 *
 * `room_member` carries a single `subject_id` alongside separate
 * `person_id` / `agent_id` columns, which is what makes the conflict
 * key and the kind filters worth exercising against a real engine rather
 * than a fake pool: a wrong `ON CONFLICT` target silently duplicates
 * members, and a missing kind filter leaks people into the agent list.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import {
  agentId,
  personId,
  roomId,
  roomMessageId,
  sessionId,
} from "../../domain/ids.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import type { Pool } from "./client.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresRoomRepository } from "./room-repo.js";
import { PostgresSessionRepository } from "./session-repo.js";

describe("PostgresRoomRepository", () => {
  let pool: Pool;
  let rooms: PostgresRoomRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let sessions: PostgresSessionRepository;

  let alice: string;
  let bob: string;
  let alicesTeam: string;
  let bobsTeam: string;

  beforeAll(() => {
    pool = createTestPool();
    rooms = new PostgresRoomRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
    sessions = new PostgresSessionRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    alice = (await persons.create({ id: personId(), name: "Alice" })).id;
    bob = (await persons.create({ id: personId(), name: "Bob" })).id;
    alicesTeam = (
      await agents.create({
        id: agentId(),
        name: "Alice's Team",
        owner_id: alice,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      })
    ).id;
    bobsTeam = (
      await agents.create({
        id: agentId(),
        name: "Bob's Team",
        owner_id: bob,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      })
    ).id;
  });

  async function newRoom(overrides: Record<string, unknown> = {}) {
    return rooms.create({
      id: roomId(),
      name: "Launch war room",
      owner_person_id: alice,
      ...overrides,
    });
  }

  // ── Room CRUD ──────────────────────────────────────────────────────────

  it("creates a room and reads it back", async () => {
    const room = await newRoom();

    expect(room).toMatchObject({ name: "Launch war room", owner_person_id: alice });
    expect(room.created_at).toBeInstanceOf(Date);
    expect(room.updated_at).toBeInstanceOf(Date);
    expect(await rooms.findById(room.id)).toEqual(room);
  });

  it("returns undefined for an unknown room", async () => {
    expect(await rooms.findById("room_missing")).toBeUndefined();
  });

  it("lists a person's rooms newest-updated first, by membership not ownership", async () => {
    const owned = await newRoom({ name: "Owned" });
    const joined = await newRoom({ name: "Joined", owner_person_id: bob });
    const theirs = await newRoom({ name: "Theirs", owner_person_id: bob });
    await rooms.addPersonMember(owned.id, alice);
    await rooms.addPersonMember(joined.id, alice);
    await rooms.addPersonMember(theirs.id, bob);
    await pool.query(`UPDATE room SET updated_at = $2 WHERE id = $1`, [
      owned.id,
      new Date("2026-01-01T00:00:00Z"),
    ]);
    await pool.query(`UPDATE room SET updated_at = $2 WHERE id = $1`, [
      joined.id,
      new Date("2026-02-01T00:00:00Z"),
    ]);

    // A room Alice owns but never joined would not appear — the join is
    // on room_member, which is the access surface the routes gate on.
    expect((await rooms.listForPerson(alice)).map((r) => r.name)).toEqual([
      "Joined",
      "Owned",
    ]);
    expect((await rooms.listForPerson(bob)).map((r) => r.name)).toEqual(["Theirs"]);
    expect(await rooms.listForPerson("person_nobody")).toEqual([]);
  });

  it("omits a room the person owns but never joined", async () => {
    await newRoom();

    expect(await rooms.listForPerson(alice)).toEqual([]);
  });

  // ── Membership ─────────────────────────────────────────────────────────

  it("adds person and agent members, tagging each with its kind", async () => {
    const room = await newRoom();

    await rooms.addPersonMember(room.id, alice);
    await rooms.addAgentMember(room.id, alicesTeam);

    const members = await rooms.listMembers(room.id);
    expect(members).toHaveLength(2);
    expect(members.map((m) => [m.kind, m.subject_id])).toEqual([
      ["person", alice],
      ["agent", alicesTeam],
    ]);
    expect(members[0]!.room_id).toBe(room.id);
    expect(members[0]!.joined_at).toBeInstanceOf(Date);
  });

  it("is idempotent — re-adding the same member does not duplicate it", async () => {
    const room = await newRoom();

    await rooms.addPersonMember(room.id, alice);
    await rooms.addPersonMember(room.id, alice);
    await rooms.addAgentMember(room.id, alicesTeam);
    await rooms.addAgentMember(room.id, alicesTeam);

    expect(await rooms.listMembers(room.id)).toHaveLength(2);
  });

  it("orders members by join time", async () => {
    const room = await newRoom();
    await rooms.addPersonMember(room.id, alice);
    await rooms.addPersonMember(room.id, bob);
    await pool.query(
      `UPDATE room_member SET joined_at = $3 WHERE room_id = $1 AND subject_id = $2`,
      [room.id, bob, new Date("2020-01-01T00:00:00Z")],
    );

    expect((await rooms.listMembers(room.id)).map((m) => m.subject_id)).toEqual([
      bob,
      alice,
    ]);
  });

  it("filters the agent id list by kind, leaving people out", async () => {
    const room = await newRoom();
    await rooms.addPersonMember(room.id, alice);
    await rooms.addPersonMember(room.id, bob);
    await rooms.addAgentMember(room.id, alicesTeam);

    // People and agents share `subject_id`, so the kind filter is the only
    // thing keeping the two person rows out of this list.
    expect(await rooms.listMemberAgentIds(room.id)).toEqual([alicesTeam]);
  });

  it("returns empty id lists for a room with no members", async () => {
    const room = await newRoom();

    expect(await rooms.listMembers(room.id)).toEqual([]);
    expect(await rooms.listMemberAgentIds(room.id)).toEqual([]);
  });

  it("answers isMember for people only, not for agents", async () => {
    const room = await newRoom();
    const other = await newRoom({ name: "Other" });
    await rooms.addPersonMember(room.id, alice);
    await rooms.addAgentMember(room.id, alicesTeam);

    expect(await rooms.isMember(room.id, alice)).toBe(true);
    expect(await rooms.isMember(room.id, bob)).toBe(false);
    // An agent id must not satisfy the person gate even though both live
    // in `subject_id` — the kind filter is what keeps them apart.
    expect(await rooms.isMember(room.id, alicesTeam)).toBe(false);
    expect(await rooms.isMember(other.id, alice)).toBe(false);
    expect(await rooms.isMember("room_missing", alice)).toBe(false);
  });




  // ── Messages ───────────────────────────────────────────────────────────

  it("appends a human message with its sender", async () => {
    const room = await newRoom();

    const msg = await rooms.appendMessage({
      id: roomMessageId(),
      room_id: room.id,
      kind: "human",
      sender_person_id: alice,
      content: "standup at 10",
    });

    expect(msg).toMatchObject({
      room_id: room.id,
      kind: "human",
      sender_person_id: alice,
      content: "standup at 10",
    });
    expect(msg.sender_agent_id).toBeUndefined();
    expect(msg.session_id).toBeUndefined();
    expect(msg.created_at).toBeInstanceOf(Date);
  });

  it("appends an agent message carrying its session id", async () => {
    const room = await newRoom();
    const session = await sessions.create({
      id: sessionId(),
      agent_id: alicesTeam,
      type: "chat",
      status: "succeeded",
      intent: "reply in the room",
    });

    const msg = await rooms.appendMessage({
      id: roomMessageId(),
      room_id: room.id,
      kind: "agent",
      sender_agent_id: alicesTeam,
      content: "on it",
      session_id: session.id,
    });

    expect(msg).toMatchObject({
      kind: "agent",
      sender_agent_id: alicesTeam,
      session_id: session.id,
    });
    expect(msg.sender_person_id).toBeUndefined();
  });

  it("lists messages oldest-first, scoped to the room and capped", async () => {
    const room = await newRoom();
    const other = await newRoom({ name: "Other" });
    const first = await rooms.appendMessage({
      id: roomMessageId(),
      room_id: room.id,
      kind: "human",
      sender_person_id: alice,
      content: "one",
    });
    const second = await rooms.appendMessage({
      id: roomMessageId(),
      room_id: room.id,
      kind: "human",
      sender_person_id: alice,
      content: "two",
    });
    await rooms.appendMessage({
      id: roomMessageId(),
      room_id: other.id,
      kind: "human",
      sender_person_id: alice,
      content: "elsewhere",
    });
    await pool.query(`UPDATE room_message SET created_at = $2 WHERE id = $1`, [
      first.id,
      new Date("2026-01-01T00:00:00Z"),
    ]);
    await pool.query(`UPDATE room_message SET created_at = $2 WHERE id = $1`, [
      second.id,
      new Date("2026-02-01T00:00:00Z"),
    ]);

    expect((await rooms.listMessages(room.id)).map((m) => m.content)).toEqual([
      "one",
      "two",
    ]);
    // The limit takes the oldest N, matching the ASC ordering.
    expect((await rooms.listMessages(room.id, 1)).map((m) => m.content)).toEqual(["one"]);
    expect(await rooms.listMessages("room_missing")).toEqual([]);
  });

  it("breaks a created_at tie by id so the order is stable", async () => {
    const room = await newRoom();
    const sameInstant = new Date("2026-03-01T00:00:00Z");
    for (const content of ["a", "b", "c"]) {
      const msg = await rooms.appendMessage({
        id: roomMessageId(),
        room_id: room.id,
        kind: "human",
        sender_person_id: alice,
        content,
      });
      await pool.query(`UPDATE room_message SET created_at = $2 WHERE id = $1`, [
        msg.id,
        sameInstant,
      ]);
    }

    const listed = await rooms.listMessages(room.id);
    expect(listed.map((m) => m.id)).toEqual([...listed.map((m) => m.id)].sort());
    expect(await rooms.listMessages(room.id)).toEqual(listed);
  });

  it("defaults the message limit to 200", async () => {
    const room = await newRoom();
    for (let i = 0; i < 201; i++) {
      await rooms.appendMessage({
        id: roomMessageId(),
        room_id: room.id,
        kind: "human",
        sender_person_id: alice,
        content: `m${i}`,
      });
    }

    expect(await rooms.listMessages(room.id)).toHaveLength(200);
    expect(await rooms.listMessages(room.id, 201)).toHaveLength(201);
  });

  it("cascades members and messages away with the room", async () => {
    const room = await newRoom();
    await rooms.addPersonMember(room.id, alice);
    await rooms.appendMessage({
      id: roomMessageId(),
      room_id: room.id,
      kind: "human",
      sender_person_id: alice,
      content: "hi",
    });

    await pool.query(`DELETE FROM room WHERE id = $1`, [room.id]);

    expect(await rooms.findById(room.id)).toBeUndefined();
    expect(await rooms.listMembers(room.id)).toEqual([]);
    expect(await rooms.listMessages(room.id)).toEqual([]);
  });
});
