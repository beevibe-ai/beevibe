/**
 * `POST /signup` — unit tests with vitest fakes (no DB).
 *
 * Signup is unauthenticated and idempotent on email, which makes the
 * "email already exists" branch the interesting one: it must verify the
 * supplied password before handing back the existing key, or the route
 * turns into a credential-stuffing oracle. The other axis is the
 * provision path — new person → new key → team agent, with the agent
 * step skipped when one already exists.
 */
import express, { json } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  CoreMemoryBlockRepository,
  NewAgent,
  NewPerson,
  Person,
  PersonRepository,
} from "@beevibe/core";
import { hashPassword } from "@beevibe/core/auth";
import { createSignupRouter } from "./signup.js";

const PASSWORD = "correct-horse-battery";

function makePersonRepo(): PersonRepository {
  return {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findByApiKey: vi.fn(),
    findManyByIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function makeAgentRepo(): AgentRepository {
  return {
    findById: vi.fn(),
    findByApiKey: vi.fn(),
    findTopLevelForOwner: vi.fn(),
    findSubordinates: vi.fn(),
    findPeers: vi.fn(),
    findParent: vi.fn(),
    findByLevel: vi.fn(),
    findDescendantIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function makeCoreMemoryRepo(): CoreMemoryBlockRepository {
  return {
    findByAgentId: vi.fn(),
    findByNames: vi.fn(),
    upsert: vi.fn(),
    updateContent: vi.fn(),
    initDefaults: vi.fn().mockResolvedValue([]),
  } as unknown as CoreMemoryBlockRepository;
}

function fakePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: "person_1",
    name: "Ada",
    email: "ada@example.com",
    api_key: "bv_u_existing",
    capability_network_enabled: true,
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_a",
    name: "Ada's team",
    owner_id: "person_1",
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

interface Fakes {
  personRepo: PersonRepository;
  agentRepo: AgentRepository;
  coreMemoryRepo: CoreMemoryBlockRepository;
}

/**
 * Wire the fakes so `provisionUser` / `provisionAgent` (the real core
 * functions — the route calls them directly) echo back rows built from
 * the input they were handed.
 */
function makeFakes(): Fakes {
  const personRepo = makePersonRepo();
  const agentRepo = makeAgentRepo();
  vi.mocked(personRepo.create).mockImplementation(async (input: NewPerson) =>
    fakePerson({ ...input, id: input.id ?? "person_new" } as Partial<Person>),
  );
  vi.mocked(agentRepo.create).mockImplementation(async (input: NewAgent) =>
    fakeAgent(input as Partial<Agent>),
  );
  return { personRepo, agentRepo, coreMemoryRepo: makeCoreMemoryRepo() };
}

function makeApp(fakes: Fakes, enabled?: boolean) {
  const app = express();
  app.use(json());
  app.use("/", createSignupRouter({ ...fakes, ...(enabled === undefined ? {} : { enabled }) }));
  return app;
}

function body(overrides: Record<string, unknown> = {}) {
  return { name: "Ada", email: "ada@example.com", password: PASSWORD, ...overrides };
}

let hash: string;
beforeEach(async () => {
  hash ??= await hashPassword(PASSWORD);
});

describe("POST /signup — validation", () => {
  it.each([
    ["missing name", { name: undefined }],
    ["blank name", { name: "   " }],
    ["name over 80 chars", { name: "a".repeat(81) }],
    ["name with a control character", { name: "Ada\u0007" }],
    ["name with markup", { name: "<script>" }],
  ])("400s on %s", async (_label, overrides) => {
    const fakes = makeFakes();
    const res = await request(makeApp(fakes)).post("/signup").send(body(overrides));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_name");
    expect(fakes.personRepo.findByEmail).not.toHaveBeenCalled();
  });

  it("accepts unicode letters, digits and the allowed punctuation in a name", async () => {
    const fakes = makeFakes();
    vi.mocked(fakes.personRepo.findByEmail).mockResolvedValue(undefined);
    vi.mocked(fakes.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const res = await request(makeApp(fakes)).post("/signup").send(body({ name: "Ada O'Hára-Lövelace 2" }));

    expect(res.status).toBe(200);
  });

  it("400s on an invalid email", async () => {
    const fakes = makeFakes();
    const res = await request(makeApp(fakes)).post("/signup").send(body({ email: "not-an-email" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_email");
  });

  it("400s on a password below the minimum length", async () => {
    const fakes = makeFakes();
    const res = await request(makeApp(fakes)).post("/signup").send(body({ password: "short" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_password");
    expect(res.body.message).toMatch(/at least/);
  });

  it("400s on an empty body", async () => {
    const fakes = makeFakes();
    const res = await request(makeApp(fakes)).post("/signup").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_name");
  });
});

describe("POST /signup — new user", () => {
  it("provisions a person, a bv_u_ key and a team agent", async () => {
    const fakes = makeFakes();
    vi.mocked(fakes.personRepo.findByEmail).mockResolvedValue(undefined);
    vi.mocked(fakes.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const res = await request(makeApp(fakes)).post("/signup").send(body());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.existed).toBe(false);
    expect(res.body.api_key).toMatch(/^bv_u_/);
    expect(res.body.person).toMatchObject({ name: "Ada", email: "ada@example.com" });
    expect(res.body.primary_agent.hierarchy).toBe("team");

    const created = vi.mocked(fakes.agentRepo.create).mock.calls[0]![0];
    expect(created).toMatchObject({
      name: "Ada's team",
      hierarchy_level: "team",
      runtime_config: { type: "claude" },
    });
  });

  it("stores a hash rather than the plaintext password", async () => {
    const fakes = makeFakes();
    vi.mocked(fakes.personRepo.findByEmail).mockResolvedValue(undefined);
    vi.mocked(fakes.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    await request(makeApp(fakes)).post("/signup").send(body());

    const created = vi.mocked(fakes.personRepo.create).mock.calls[0]![0];
    expect(created.password_hash).toBeTruthy();
    expect(created.password_hash).not.toBe(PASSWORD);
  });

  it("normalises the email to lowercase and trims it", async () => {
    const fakes = makeFakes();
    vi.mocked(fakes.personRepo.findByEmail).mockResolvedValue(undefined);
    vi.mocked(fakes.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const res = await request(makeApp(fakes)).post("/signup").send(body({ email: " ADA@Example.COM " }));

    expect(fakes.personRepo.findByEmail).toHaveBeenCalledWith("ada@example.com");
    expect(res.body.person.email).toBe("ada@example.com");
  });
});

describe("POST /signup — existing email", () => {
  it("returns the existing key when the password matches", async () => {
    const fakes = makeFakes();
    vi.mocked(fakes.personRepo.findByEmail).mockResolvedValue(
      fakePerson({ password_hash: hash }),
    );
    vi.mocked(fakes.agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());

    const res = await request(makeApp(fakes)).post("/signup").send(body());

    expect(res.status).toBe(200);
    expect(res.body.existed).toBe(true);
    expect(res.body.api_key).toBe("bv_u_existing");
    expect(fakes.personRepo.create).not.toHaveBeenCalled();
    expect(fakes.agentRepo.create).not.toHaveBeenCalled();
  });

  it("401s — and leaks no key — when the password does not match", async () => {
    const fakes = makeFakes();
    vi.mocked(fakes.personRepo.findByEmail).mockResolvedValue(
      fakePerson({ password_hash: hash }),
    );

    const res = await request(makeApp(fakes))
      .post("/signup")
      .send(body({ password: "not-the-right-password" }));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
    expect(res.body.api_key).toBeUndefined();
    expect(fakes.personRepo.update).not.toHaveBeenCalled();
  });

  it("adopts the supplied password for a legacy account that has none", async () => {
    const fakes = makeFakes();
    vi.mocked(fakes.personRepo.findByEmail).mockResolvedValue(fakePerson());
    vi.mocked(fakes.agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());

    const res = await request(makeApp(fakes)).post("/signup").send(body());

    expect(res.status).toBe(200);
    expect(res.body.api_key).toBe("bv_u_existing");
    const [id, patch] = vi.mocked(fakes.personRepo.update).mock.calls[0]!;
    expect(id).toBe("person_1");
    expect(patch.password_hash).toBeTruthy();
    expect(patch.password_hash).not.toBe(PASSWORD);
  });

  it("backfills a missing team agent for an existing person", async () => {
    const fakes = makeFakes();
    vi.mocked(fakes.personRepo.findByEmail).mockResolvedValue(
      fakePerson({ password_hash: hash }),
    );
    vi.mocked(fakes.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const res = await request(makeApp(fakes)).post("/signup").send(body());

    expect(res.status).toBe(200);
    expect(res.body.existed).toBe(true);
    expect(fakes.agentRepo.create).toHaveBeenCalledTimes(1);
    // The agent is named after the stored person, not the request body,
    // so a re-signup with a different display name can't rename the team.
    expect(vi.mocked(fakes.agentRepo.create).mock.calls[0]![0]!.name).toBe("Ada's team");
  });

  it("treats a row with no api_key as a fresh signup", async () => {
    const fakes = makeFakes();
    const person = fakePerson({ password_hash: hash });
    delete person.api_key;
    vi.mocked(fakes.personRepo.findByEmail).mockResolvedValue(person);
    vi.mocked(fakes.agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());

    const res = await request(makeApp(fakes)).post("/signup").send(body());

    expect(res.status).toBe(200);
    expect(res.body.existed).toBe(false);
    expect(fakes.personRepo.create).toHaveBeenCalledTimes(1);
  });
});

describe("POST /signup — lockdown and failures", () => {
  it("404s when signup is disabled", async () => {
    const fakes = makeFakes();
    const res = await request(makeApp(fakes, false)).post("/signup").send(body());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("signup_disabled");
    expect(fakes.personRepo.findByEmail).not.toHaveBeenCalled();
  });

  it("500s when a repo throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fakes = makeFakes();
    vi.mocked(fakes.personRepo.findByEmail).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(fakes)).post("/signup").send(body());

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error", message: "pg down" });
  });
});
