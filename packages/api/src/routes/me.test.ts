/**
 * /me identity + onboarding surface — unit tests with vitest fakes (no DB).
 *
 * Three handlers with distinct risks: `GET /me` shapes the payload the
 * web's `/welcome` gate branches on, `PATCH /me/preferences` is the only
 * write that must reject a non-boolean, and `GET /health/runtime` folds
 * two independent probes (claude CLI, OpenAI embeddings) into one `ok`
 * with a deliberate "skipped counts as ok" rule.
 */
import express, { json } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  EmbeddingService,
  Person,
  PersonRepository,
  RuntimeRegistry,
} from "@beevibe/core";
import { createMeRouter } from "./me.js";

const PERSON = "person_1";

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

function fakePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: PERSON,
    name: "Ada",
    email: "ada@example.com",
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
    owner_id: PERSON,
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

/** A registry carrying only the `healthCheck` the route actually calls. */
function makeRegistry(
  healthCheck?: () => Promise<{ healthy: boolean; error?: string }>,
): RuntimeRegistry {
  if (!healthCheck) return {} as RuntimeRegistry;
  return { claude: { healthCheck } } as unknown as RuntimeRegistry;
}

function makeEmbed(impl: () => Promise<number[]>): EmbeddingService {
  return {
    type: "fake",
    embed: vi.fn(impl),
    embedBatch: vi.fn(),
  } as unknown as EmbeddingService;
}

function stubAuth(source: "human" | "agent" | "none" = "human") {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (source === "human") {
      req.caller = {
        source: "human",
        agentId: "agent_a",
        hierarchyLevel: "team",
        personId: PERSON,
      };
    } else if (source === "agent") {
      req.caller = { source: "agent", agentId: "agent_a", hierarchyLevel: "ic" };
    }
    next();
  };
}

interface AppOpts {
  personRepo?: PersonRepository;
  agentRepo?: AgentRepository;
  runtimeRegistry?: RuntimeRegistry;
  embed?: EmbeddingService;
  source?: "human" | "agent" | "none";
}

function makeApp(opts: AppOpts = {}) {
  const personRepo = opts.personRepo ?? makePersonRepo();
  const agentRepo = opts.agentRepo ?? makeAgentRepo();
  const app = express();
  app.use(json());
  app.use(
    "/",
    createMeRouter({
      authMiddleware: stubAuth(opts.source ?? "human"),
      personRepo,
      agentRepo,
      runtimeRegistry: opts.runtimeRegistry ?? makeRegistry(),
      ...(opts.embed ? { embed: opts.embed } : {}),
    }),
  );
  return { app, personRepo, agentRepo };
}

// ── GET /me ──────────────────────────────────────────────────────────────

describe("GET /me", () => {
  it("returns person, primary agent and preferences", async () => {
    const personRepo = makePersonRepo();
    const agentRepo = makeAgentRepo();
    vi.mocked(personRepo.findById).mockResolvedValue(
      fakePerson({ onboarding_completed_at: new Date("2026-04-02T10:00:00Z") }),
    );
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());

    const { app } = makeApp({ personRepo, agentRepo });
    const res = await request(app).get("/me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      person: {
        id: PERSON,
        name: "Ada",
        email: "ada@example.com",
        onboarding_completed_at: "2026-04-02T10:00:00.000Z",
      },
      primary_agent: { id: "agent_a", name: "Ada's team", hierarchy: "team" },
      preferences: { capability_network_enabled: true },
      needs_onboarding: false,
    });
  });

  it("flags needs_onboarding when the stamp is absent", async () => {
    const personRepo = makePersonRepo();
    const agentRepo = makeAgentRepo();
    vi.mocked(personRepo.findById).mockResolvedValue(fakePerson());
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());

    const { app } = makeApp({ personRepo, agentRepo });
    const res = await request(app).get("/me");

    expect(res.body.needs_onboarding).toBe(true);
    expect(res.body.person.onboarding_completed_at).toBeNull();
  });

  it("returns a null primary_agent rather than 404ing when no agent exists", async () => {
    const personRepo = makePersonRepo();
    const agentRepo = makeAgentRepo();
    vi.mocked(personRepo.findById).mockResolvedValue(fakePerson());
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const { app } = makeApp({ personRepo, agentRepo });
    const res = await request(app).get("/me");

    expect(res.status).toBe(200);
    expect(res.body.primary_agent).toBeNull();
  });

  it("404s when the caller's person row is gone", async () => {
    const personRepo = makePersonRepo();
    const agentRepo = makeAgentRepo();
    vi.mocked(personRepo.findById).mockResolvedValue(undefined);
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const { app } = makeApp({ personRepo, agentRepo });
    const res = await request(app).get("/me");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("person_not_found");
  });

  it("403s an agent caller", async () => {
    const { app, personRepo } = makeApp({ source: "agent" });
    const res = await request(app).get("/me");

    expect(res.status).toBe(403);
    expect(personRepo.findById).not.toHaveBeenCalled();
  });
});

// ── POST /me/onboarding/complete ─────────────────────────────────────────

describe("POST /me/onboarding/complete", () => {
  it("stamps the completion time for the caller", async () => {
    const personRepo = makePersonRepo();
    const stamped = new Date("2026-04-03T12:00:00Z");
    vi.mocked(personRepo.update).mockResolvedValue(
      fakePerson({ onboarding_completed_at: stamped }),
    );

    const { app } = makeApp({ personRepo });
    const res = await request(app).post("/me/onboarding/complete");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      onboarding_completed_at: "2026-04-03T12:00:00.000Z",
    });
    const [id, patch] = vi.mocked(personRepo.update).mock.calls[0]!;
    expect(id).toBe(PERSON);
    expect(patch.onboarding_completed_at).toBeInstanceOf(Date);
  });

  it("is idempotent — a second call just re-stamps", async () => {
    const personRepo = makePersonRepo();
    vi.mocked(personRepo.update).mockResolvedValue(
      fakePerson({ onboarding_completed_at: new Date("2026-04-03T12:00:00Z") }),
    );

    const { app } = makeApp({ personRepo });
    await request(app).post("/me/onboarding/complete");
    const res = await request(app).post("/me/onboarding/complete");

    expect(res.status).toBe(200);
    expect(personRepo.update).toHaveBeenCalledTimes(2);
  });

  it("403s an unauthenticated caller", async () => {
    const { app, personRepo } = makeApp({ source: "none" });
    const res = await request(app).post("/me/onboarding/complete");

    expect(res.status).toBe(403);
    expect(personRepo.update).not.toHaveBeenCalled();
  });
});

// ── PATCH /me/preferences ────────────────────────────────────────────────

describe("PATCH /me/preferences", () => {
  it("persists the capability-network toggle", async () => {
    const personRepo = makePersonRepo();
    vi.mocked(personRepo.update).mockResolvedValue(
      fakePerson({ capability_network_enabled: false }),
    );

    const { app } = makeApp({ personRepo });
    const res = await request(app)
      .patch("/me/preferences")
      .send({ capability_network_enabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, preferences: { capability_network_enabled: false } });
    expect(personRepo.update).toHaveBeenCalledWith(PERSON, {
      capability_network_enabled: false,
    });
  });

  it.each([
    ["a missing field", {}],
    ["a string 'true'", { capability_network_enabled: "true" }],
    ["a numeric 1", { capability_network_enabled: 1 }],
    ["an explicit null", { capability_network_enabled: null }],
  ])("400s on %s rather than coercing", async (_label, body) => {
    const personRepo = makePersonRepo();
    const { app } = makeApp({ personRepo });

    const res = await request(app).patch("/me/preferences").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(personRepo.update).not.toHaveBeenCalled();
  });

  it("403s an agent caller", async () => {
    const { app, personRepo } = makeApp({ source: "agent" });
    const res = await request(app)
      .patch("/me/preferences")
      .send({ capability_network_enabled: true });

    expect(res.status).toBe(403);
    expect(personRepo.update).not.toHaveBeenCalled();
  });
});

// ── GET /health/runtime ──────────────────────────────────────────────────

describe("GET /health/runtime", () => {
  it("reports ok when the CLI is healthy and embeddings resolve", async () => {
    const { app } = makeApp({
      runtimeRegistry: makeRegistry(async () => ({ healthy: true })),
      embed: makeEmbed(async () => [0.1, 0.2]),
    });

    const res = await request(app).get("/health/runtime");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      claude_cli: { ok: true },
      openai: { ok: true },
    });
  });

  it("treats a missing embed service as skipped-but-ok", async () => {
    const { app } = makeApp({
      runtimeRegistry: makeRegistry(async () => ({ healthy: true })),
    });

    const res = await request(app).get("/health/runtime");

    expect(res.body.ok).toBe(true);
    expect(res.body.openai).toEqual({ ok: true, skipped: true });
  });

  it("surfaces the CLI's own error message when the probe returns unhealthy", async () => {
    const { app } = makeApp({
      runtimeRegistry: makeRegistry(async () => ({ healthy: false, error: "claude: not found" })),
    });

    const res = await request(app).get("/health/runtime");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.claude_cli).toEqual({ ok: false, message: "claude: not found" });
  });

  it("falls back to a default message when an unhealthy probe carries no error", async () => {
    const { app } = makeApp({
      runtimeRegistry: makeRegistry(async () => ({ healthy: false })),
    });

    const res = await request(app).get("/health/runtime");

    expect(res.body.claude_cli.message).toBe("claude --version exited non-zero");
  });

  it("reports the registry gap when no claude runtime is registered", async () => {
    const { app } = makeApp({ runtimeRegistry: makeRegistry() });

    const res = await request(app).get("/health/runtime");

    expect(res.body.ok).toBe(false);
    expect(res.body.claude_cli).toEqual({
      ok: false,
      message: "claude runtime not registered",
    });
  });

  it("reports a failing embed probe without taking down the CLI verdict", async () => {
    const { app } = makeApp({
      runtimeRegistry: makeRegistry(async () => ({ healthy: true })),
      embed: makeEmbed(async () => {
        throw new Error("401 Unauthorized\nkey revoked");
      }),
    });

    const res = await request(app).get("/health/runtime");

    expect(res.body.ok).toBe(false);
    expect(res.body.claude_cli).toEqual({ ok: true });
    // First line only, so a multi-line provider error can't flood the UI.
    expect(res.body.openai).toEqual({ ok: false, message: "401 Unauthorized" });
  });

  it("stringifies a non-Error rejection and caps its length", async () => {
    const { app } = makeApp({
      runtimeRegistry: makeRegistry(() => Promise.reject("x".repeat(500))),
    });

    const res = await request(app).get("/health/runtime");

    expect(res.body.claude_cli.ok).toBe(false);
    expect(res.body.claude_cli.message).toHaveLength(200);
  });

  it("403s a non-human caller", async () => {
    const { app } = makeApp({
      source: "agent",
      runtimeRegistry: makeRegistry(async () => ({ healthy: true })),
    });

    const res = await request(app).get("/health/runtime");

    expect(res.status).toBe(403);
  });
});
