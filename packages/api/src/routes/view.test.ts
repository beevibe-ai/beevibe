/**
 * Read-only view routes — unit tests with vitest fakes (no DB).
 *
 * Every handler in `view.ts` is a thin shell around a `views/*.ts`
 * composer that talks pg directly, so the composers are mocked at the
 * module boundary and the pool is a `vi.fn()`. What's left — and what
 * this suite pins — is the shell itself: the human gate, query-param
 * parsing and validation, the "mine" → primary-agent resolution, the
 * ownership checks on every mutation, and the 400/403/404/409/500
 * error contract clients branch on.
 */
import express, { json } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  DaemonRepository,
  MemoryFactRepository,
  RuntimeRepository,
} from "@beevibe/core";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { CoreMemory } from "@beevibe/core/services/memory";
import {
  BlockCharLimitExceededError,
  BlockNotFoundError,
} from "@beevibe/core/services/memory";

// ── View-composer mocks ──────────────────────────────────────────────────
// Each is pure SQL over the pool; the router's job is deciding *what* to
// pass them and *how* to translate the result, which is what's asserted.

vi.mock("../views/tasks.js", () => ({
  listTasks: vi.fn(async () => [{ id: "task_1" }]),
  getTask: vi.fn(async () => ({ id: "task_1" })),
}));
vi.mock("../views/agents.js", () => ({
  listAgents: vi.fn(async () => [{ id: "agent_1" }]),
  getAgent: vi.fn(async () => ({ id: "agent_1" })),
}));
vi.mock("../views/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../views/sessions.js")>();
  return {
    AmbiguousShortIdError: actual.AmbiguousShortIdError,
    getSessionByShortId: vi.fn(async () => ({ id: "sess_1" })),
    getConversationByShortId: vi.fn(async () => ({ sessions: [] })),
    getSessionTree: vi.fn(async () => ({ root: "sess_1", nodes: [] })),
  };
});
vi.mock("../views/memory.js", () => ({
  listMemoryFacts: vi.fn(async () => [{ id: "fact_1" }]),
  listMemoryFactCounts: vi.fn(async () => ({ ic: 1 })),
}));
vi.mock("../views/dashboard.js", () => ({
  getDashboardSummary: vi.fn(async () => ({ tasks: 0 })),
}));
vi.mock("../views/memory-activity.js", () => ({
  getMemoryActivity: vi.fn(async () => ({ weeks: [] })),
}));
vi.mock("../views/mesh.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../views/mesh.js")>();
  return {
    DEFAULT_MESH_WINDOW: actual.DEFAULT_MESH_WINDOW,
    isMeshWindow: actual.isMeshWindow,
    getMeshOverview: vi.fn(async () => ({ edges: [] })),
  };
});
vi.mock("../views/promotions.js", () => ({ listPromotions: vi.fn(async () => []) }));
vi.mock("../views/activity.js", () => ({ listActivity: vi.fn(async () => []) }));
vi.mock("../views/work-product.js", () => ({
  getWorkProduct: vi.fn(async () => ({ id: "wp_1" })),
}));
vi.mock("../views/inbox.js", () => ({ listInbox: vi.fn(async () => []) }));
vi.mock("../views/agent-network.js", () => ({
  getAgentNetwork: vi.fn(async () => ({ nodes: [] })),
}));

const { listTasks, getTask } = await import("../views/tasks.js");
const { listAgents, getAgent } = await import("../views/agents.js");
const {
  AmbiguousShortIdError,
  getSessionByShortId,
  getConversationByShortId,
  getSessionTree,
} = await import("../views/sessions.js");
const { listMemoryFacts, listMemoryFactCounts } = await import("../views/memory.js");
const { getDashboardSummary } = await import("../views/dashboard.js");
const { getMemoryActivity } = await import("../views/memory-activity.js");
const { getMeshOverview } = await import("../views/mesh.js");
const { listPromotions } = await import("../views/promotions.js");
const { listActivity } = await import("../views/activity.js");
const { getWorkProduct } = await import("../views/work-product.js");
const { listInbox } = await import("../views/inbox.js");
const { getAgentNetwork } = await import("../views/agent-network.js");
const { createViewRouter } = await import("./view.js");

// ── Fixtures ─────────────────────────────────────────────────────────────

const PERSON = "person_alice";
const OTHER = "person_bob";
const AGENT = "agent_alicesteam";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Alice's Team",
    owner_id: PERSON,
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

interface Ports {
  pool: Pool;
  agentRepo: AgentRepository;
  runtimeRepo: RuntimeRepository;
  daemonRepo: DaemonRepository;
  coreMemory: CoreMemory;
  memoryFactRepo: MemoryFactRepository;
}

function makePorts(overrides: Partial<Ports> = {}): Ports {
  return {
    pool: { query: vi.fn(async () => ({ rows: [{ owner_id: PERSON }] })) } as unknown as Pool,
    agentRepo: {
      findById: vi.fn(async () => fakeAgent()),
      findTopLevelForOwner: vi.fn(async () => fakeAgent()),
      update: vi.fn(async (_id: string, patch: Partial<Agent>) => fakeAgent(patch)),
    } as unknown as AgentRepository,
    runtimeRepo: {
      findById: vi.fn(async () => ({ id: "rt_1", daemon_id: "dmn_1", cli: "claude" })),
    } as unknown as RuntimeRepository,
    daemonRepo: {
      findById: vi.fn(async () => ({ id: "dmn_1", owner_person_id: PERSON })),
    } as unknown as DaemonRepository,
    coreMemory: { setContent: vi.fn(async () => {}) } as unknown as CoreMemory,
    memoryFactRepo: {
      findById: vi.fn(async () => ({ id: "fact_1", agent_id: AGENT })),
      delete: vi.fn(async () => {}),
    } as unknown as MemoryFactRepository,
    ...overrides,
  };
}

function stubAuth(source: "human" | "agent" | "none") {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (source === "human") {
      req.caller = {
        source: "human",
        agentId: AGENT,
        hierarchyLevel: "team",
        personId: PERSON,
      };
    } else if (source === "agent") {
      req.caller = { source: "agent", agentId: AGENT, hierarchyLevel: "ic" };
    }
    next();
  };
}

function makeApp(ports: Ports = makePorts(), source: "human" | "agent" | "none" = "human") {
  const app = express();
  app.use(json());
  app.use("/", createViewRouter({ authMiddleware: stubAuth(source), ...ports }));
  return app;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/**
 * Every route sits behind `requireHuman`. Rather than repeat the same
 * two 403 cases 20 times, drive them off the route table.
 */
const ALL_ROUTES: ReadonlyArray<[method: "get" | "post" | "delete", path: string]> = [
  ["get", "/task"],
  ["get", "/task/task_1"],
  ["get", "/agent"],
  ["get", "/agent/network"],
  ["get", "/agent/agent_1"],
  ["post", "/agent/agent_1/runtime"],
  ["post", "/agent/agent_1/model"],
  ["post", "/agent/agent_1/review-policy"],
  ["post", "/agent/agent_1/core-memory/persona"],
  ["post", "/agent/agent_1/archive"],
  ["get", "/session/abc123"],
  ["get", "/session/abc123/conversation"],
  ["get", "/session/sess_1/tree"],
  ["get", "/dashboard"],
  ["get", "/memory/activity"],
  ["get", "/mesh"],
  ["get", "/promotion"],
  ["get", "/memory/fact"],
  ["get", "/memory/fact/counts"],
  ["delete", "/memory/fact/fact_1"],
  ["get", "/work-product/wp_1"],
  ["get", "/inbox"],
  ["get", "/activity"],
];

describe("human gate", () => {
  it.each(ALL_ROUTES)("403s an agent caller on %s %s", async (method, path) => {
    const res = await request(makeApp(makePorts(), "agent"))[method](path);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });

  it.each(ALL_ROUTES)("403s an unauthenticated caller on %s %s", async (method, path) => {
    const res = await request(makeApp(makePorts(), "none"))[method](path);
    expect(res.status).toBe(403);
  });
});

// ── GET /task ────────────────────────────────────────────────────────────

describe("GET /task", () => {
  it("always scopes to the caller's owner tree", async () => {
    const res = await request(makeApp()).get("/task");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "task_1" }]);
    expect(vi.mocked(listTasks).mock.calls[0]![1]).toEqual({ caller_person_id: PERSON });
  });

  it.each(["pending", "in_progress", "blocked", "in_review", "done", "archived"])(
    "passes through the %s lifecycle filter",
    async (lifecycle) => {
      await request(makeApp()).get(`/task?lifecycle=${lifecycle}`);

      expect(vi.mocked(listTasks).mock.calls[0]![1]).toMatchObject({ lifecycle });
    },
  );

  it.each(["nonsense", ""])("drops an unknown lifecycle value %j", async (lifecycle) => {
    await request(makeApp()).get(`/task?lifecycle=${lifecycle}`);

    expect(vi.mocked(listTasks).mock.calls[0]![1]).not.toHaveProperty("lifecycle");
  });

  it.each(["all", "sprint", "timeline"])("passes through the %s view", async (view) => {
    await request(makeApp()).get(`/task?view=${view}`);

    expect(vi.mocked(listTasks).mock.calls[0]![1]).toMatchObject({ view });
  });

  it("drops an unknown view value", async () => {
    await request(makeApp()).get("/task?view=kanban");

    expect(vi.mocked(listTasks).mock.calls[0]![1]).not.toHaveProperty("view");
  });

  it("resolves view=mine to the caller's primary agent", async () => {
    const ports = makePorts();
    await request(makeApp(ports)).get("/task?view=mine");

    expect(ports.agentRepo.findTopLevelForOwner).toHaveBeenCalledWith(PERSON);
    expect(vi.mocked(listTasks).mock.calls[0]![1]).toMatchObject({
      view: "mine",
      assignee_id: AGENT,
    });
  });

  it("short-circuits view=mine to an empty list when the caller has no agent", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).get("/task?view=mine");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("honours an explicit assignee_id outside view=mine", async () => {
    await request(makeApp()).get("/task?assignee_id=agent_other");

    expect(vi.mocked(listTasks).mock.calls[0]![1]).toMatchObject({
      assignee_id: "agent_other",
    });
  });

  it("ignores assignee_id when view=mine already resolved one", async () => {
    await request(makeApp()).get("/task?view=mine&assignee_id=agent_other");

    expect(vi.mocked(listTasks).mock.calls[0]![1]).toMatchObject({ assignee_id: AGENT });
  });

  it("500s when the composer throws", async () => {
    vi.mocked(listTasks).mockRejectedValueOnce(new Error("pg down"));

    const res = await request(makeApp()).get("/task");

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "internal_error", message: "pg down" });
  });
});

// ── GET /task/:id ────────────────────────────────────────────────────────

describe("GET /task/:id", () => {
  it("returns the detail row", async () => {
    const res = await request(makeApp()).get("/task/task_1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "task_1" });
  });

  it("404s an unknown task", async () => {
    vi.mocked(getTask).mockResolvedValueOnce(undefined as never);

    const res = await request(makeApp()).get("/task/task_x");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("task_not_found");
  });

  it("500s when the composer throws", async () => {
    vi.mocked(getTask).mockRejectedValueOnce(new Error("pg down"));

    const res = await request(makeApp()).get("/task/task_1");

    expect(res.status).toBe(500);
  });
});

// ── GET /agent, /agent/network, /agent/:id ───────────────────────────────

describe("GET /agent", () => {
  it("scopes the list to the caller's tree", async () => {
    const res = await request(makeApp()).get("/agent");

    expect(res.status).toBe(200);
    expect(vi.mocked(listAgents).mock.calls[0]![1]).toBe(PERSON);
  });

  it("500s when the composer throws", async () => {
    vi.mocked(listAgents).mockRejectedValueOnce(new Error("pg down"));

    expect((await request(makeApp()).get("/agent")).status).toBe(500);
  });
});

describe("GET /agent/network", () => {
  it("matches before /agent/:id rather than being read as an id", async () => {
    const res = await request(makeApp()).get("/agent/network");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ nodes: [] });
    expect(getAgentNetwork).toHaveBeenCalled();
    expect(getAgent).not.toHaveBeenCalled();
  });

  it("500s when the composer throws", async () => {
    vi.mocked(getAgentNetwork).mockRejectedValueOnce(new Error("pg down"));

    expect((await request(makeApp()).get("/agent/network")).status).toBe(500);
  });
});

describe("GET /agent/:id", () => {
  it("returns the detail row", async () => {
    const res = await request(makeApp()).get("/agent/agent_1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "agent_1" });
  });

  it("404s an unknown agent", async () => {
    vi.mocked(getAgent).mockResolvedValueOnce(undefined as never);

    const res = await request(makeApp()).get("/agent/agent_x");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
  });

  it("500s when the composer throws", async () => {
    vi.mocked(getAgent).mockRejectedValueOnce(new Error("pg down"));

    expect((await request(makeApp()).get("/agent/agent_1")).status).toBe(500);
  });
});

// ── POST /agent/:id/runtime ──────────────────────────────────────────────

describe("POST /agent/:id/runtime", () => {
  it("binds a runtime the caller owns and syncs runtime_config.type", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findById).mockResolvedValue(
      fakeAgent({ runtime_config: { type: "codex", model: "o3" } }),
    );
    vi.mocked(ports.runtimeRepo.findById).mockResolvedValue({
      id: "rt_1",
      daemon_id: "dmn_1",
      cli: "claude",
    } as never);

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/runtime`)
      .send({ runtime_id: "rt_1" });

    expect(res.status).toBe(200);
    // The model (and every other config field) survives the type sync.
    expect(vi.mocked(ports.agentRepo.update).mock.calls[0]![1]).toEqual({
      preferred_runtime_id: "rt_1",
      runtime_config: { type: "claude", model: "o3" },
    });
  });

  it("leaves runtime_config alone when the CLI already matches", async () => {
    const ports = makePorts();

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/runtime`)
      .send({ runtime_id: "rt_1" });

    expect(res.status).toBe(200);
    expect(vi.mocked(ports.agentRepo.update).mock.calls[0]![1]).toEqual({
      preferred_runtime_id: "rt_1",
    });
  });

  it("unbinds on an explicit null without touching the CLI preference", async () => {
    const ports = makePorts();

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/runtime`)
      .send({ runtime_id: null });

    expect(res.status).toBe(200);
    expect(res.body.preferred_runtime_id).toBeNull();
    expect(ports.runtimeRepo.findById).not.toHaveBeenCalled();
    expect(vi.mocked(ports.agentRepo.update).mock.calls[0]![1]).toEqual({
      preferred_runtime_id: null,
    });
  });

  it.each([{}, { runtime_id: "" }, { runtime_id: 3 }])(
    "400s a malformed body %j",
    async (body) => {
      const ports = makePorts();
      const res = await request(makeApp(ports)).post(`/agent/${AGENT}/runtime`).send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
      expect(ports.agentRepo.update).not.toHaveBeenCalled();
    },
  );

  it("404s an unknown agent", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findById).mockResolvedValue(undefined);

    const res = await request(makeApp(ports))
      .post("/agent/agent_x/runtime")
      .send({ runtime_id: "rt_1" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
  });

  it("403s an agent the caller doesn't own", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findById).mockResolvedValue(fakeAgent({ owner_id: OTHER }));

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/runtime`)
      .send({ runtime_id: "rt_1" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_owner");
  });

  it("404s an unknown runtime", async () => {
    const ports = makePorts();
    vi.mocked(ports.runtimeRepo.findById).mockResolvedValue(undefined);

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/runtime`)
      .send({ runtime_id: "rt_x" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("runtime_not_found");
  });

  it.each([
    ["a daemon owned by someone else", { id: "dmn_1", owner_person_id: OTHER }],
    ["a daemon row that's gone", undefined],
  ])("403s %s — cross-tenant escalation guard", async (_label, daemon) => {
    const ports = makePorts();
    vi.mocked(ports.daemonRepo.findById).mockResolvedValue(daemon as never);

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/runtime`)
      .send({ runtime_id: "rt_1" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("runtime_not_owned");
    expect(ports.agentRepo.update).not.toHaveBeenCalled();
  });

  it("409s a runtime advertising a CLI beevibe doesn't know", async () => {
    const ports = makePorts();
    vi.mocked(ports.runtimeRepo.findById).mockResolvedValue({
      id: "rt_1",
      daemon_id: "dmn_1",
      cli: "cursor",
    } as never);

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/runtime`)
      .send({ runtime_id: "rt_1" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("unknown_runtime_cli");
    expect(res.body.message).toContain("cursor");
  });

  it("500s when the update throws", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.update).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/runtime`)
      .send({ runtime_id: "rt_1" });

    expect(res.status).toBe(500);
  });
});

// ── POST /agent/:id/model ────────────────────────────────────────────────

describe("POST /agent/:id/model", () => {
  it("sets the model, preserving the rest of runtime_config", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findById).mockResolvedValue(
      fakeAgent({ runtime_config: { type: "claude", max_turns: 12 } }),
    );

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/model`)
      .send({ model: "opus" });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe("opus");
    expect(vi.mocked(ports.agentRepo.update).mock.calls[0]![1]).toEqual({
      runtime_config: { type: "claude", max_turns: 12, model: "opus" },
    });
  });

  it("clears the model on an explicit null so the CLI default applies", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findById).mockResolvedValue(
      fakeAgent({ runtime_config: { type: "claude", model: "opus" } }),
    );

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/model`)
      .send({ model: null });

    expect(res.status).toBe(200);
    expect(res.body.model).toBeNull();
    expect(vi.mocked(ports.agentRepo.update).mock.calls[0]![1]).toEqual({
      runtime_config: { type: "claude" },
    });
  });

  it("400s a malformed body", async () => {
    const res = await request(makeApp()).post(`/agent/${AGENT}/model`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("403s an agent the caller doesn't own", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findById).mockResolvedValue(fakeAgent({ owner_id: OTHER }));

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/model`)
      .send({ model: "opus" });

    expect(res.status).toBe(403);
  });

  it("500s when the update throws", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.update).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/model`)
      .send({ model: "opus" });

    expect(res.status).toBe(500);
  });
});

// ── POST /agent/:id/review-policy ────────────────────────────────────────

describe("POST /agent/:id/review-policy", () => {
  it.each(["auto_done", "require_human"])("accepts %s", async (policy) => {
    const ports = makePorts();
    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/review-policy`)
      .send({ review_policy: policy });

    expect(res.status).toBe(200);
    expect(vi.mocked(ports.agentRepo.update).mock.calls[0]![1]).toEqual({
      review_policy: policy,
    });
  });

  it.each([{}, { review_policy: "yolo" }, { review_policy: 1 }])(
    "400s an unknown policy %j",
    async (body) => {
      const ports = makePorts();
      const res = await request(makeApp(ports))
        .post(`/agent/${AGENT}/review-policy`)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
      expect(res.body.message).toContain("review_policy");
      expect(ports.agentRepo.findById).not.toHaveBeenCalled();
    },
  );

  it("404s an unknown agent", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findById).mockResolvedValue(undefined);

    const res = await request(makeApp(ports))
      .post("/agent/agent_x/review-policy")
      .send({ review_policy: "auto_done" });

    expect(res.status).toBe(404);
  });

  it("500s when the update throws", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.update).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/review-policy`)
      .send({ review_policy: "auto_done" });

    expect(res.status).toBe(500);
  });
});

// ── POST /agent/:id/core-memory/:blockName ───────────────────────────────

describe("POST /agent/:id/core-memory/:blockName", () => {
  it("overwrites the named block", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/core-memory/persona`)
      .send({ content: "Brand new." });

    expect(res.status).toBe(200);
    expect(ports.coreMemory.setContent).toHaveBeenCalledWith(AGENT, "persona", "Brand new.");
  });

  it("accepts an empty string — clearing a block is legal", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/core-memory/persona`)
      .send({ content: "" });

    expect(res.status).toBe(200);
    expect(ports.coreMemory.setContent).toHaveBeenCalledWith(AGENT, "persona", "");
  });

  it.each([{}, { content: 42 }, { content: null }])(
    "400s a non-string content %j",
    async (body) => {
      const ports = makePorts();
      const res = await request(makeApp(ports))
        .post(`/agent/${AGENT}/core-memory/persona`)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
      expect(ports.coreMemory.setContent).not.toHaveBeenCalled();
    },
  );

  it("403s an agent the caller doesn't own", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findById).mockResolvedValue(fakeAgent({ owner_id: OTHER }));

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/core-memory/persona`)
      .send({ content: "x" });

    expect(res.status).toBe(403);
    expect(ports.coreMemory.setContent).not.toHaveBeenCalled();
  });

  it("404s an unseeded block", async () => {
    const ports = makePorts();
    vi.mocked(ports.coreMemory.setContent).mockRejectedValue(
      new BlockNotFoundError(AGENT, "never_seeded"),
    );

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/core-memory/never_seeded`)
      .send({ content: "x" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("block_not_found");
    expect(res.body.message).toContain("never_seeded");
  });

  it("400s content over the block's char limit", async () => {
    const ports = makePorts();
    vi.mocked(ports.coreMemory.setContent).mockRejectedValue(
      new BlockCharLimitExceededError("persona", 11, 10),
    );

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/core-memory/persona`)
      .send({ content: "01234567890" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("char_limit_exceeded");
  });

  it("500s on any other failure", async () => {
    const ports = makePorts();
    vi.mocked(ports.coreMemory.setContent).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(ports))
      .post(`/agent/${AGENT}/core-memory/persona`)
      .send({ content: "x" });

    expect(res.status).toBe(500);
  });
});

// ── POST /agent/:id/archive ──────────────────────────────────────────────

describe("POST /agent/:id/archive", () => {
  it("stamps archived_at", async () => {
    const ports = makePorts();
    const archivedAt = new Date("2026-06-01T00:00:00Z");
    vi.mocked(ports.agentRepo.update).mockResolvedValue(fakeAgent({ archived_at: archivedAt }));

    const res = await request(makeApp(ports)).post(`/agent/${AGENT}/archive`);

    expect(res.status).toBe(200);
    expect(res.body.archived_at).toBe(archivedAt.toISOString());
    expect(vi.mocked(ports.agentRepo.update).mock.calls[0]![1].archived_at).toBeInstanceOf(Date);
  });

  it("is idempotent — an already-archived agent isn't re-stamped", async () => {
    const ports = makePorts();
    const archivedAt = new Date("2026-05-01T00:00:00Z");
    vi.mocked(ports.agentRepo.findById).mockResolvedValue(fakeAgent({ archived_at: archivedAt }));

    const res = await request(makeApp(ports)).post(`/agent/${AGENT}/archive`);

    expect(res.status).toBe(200);
    expect(res.body.archived_at).toBe(archivedAt.toISOString());
    expect(ports.agentRepo.update).not.toHaveBeenCalled();
  });

  it("403s an agent the caller doesn't own", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findById).mockResolvedValue(fakeAgent({ owner_id: OTHER }));

    expect((await request(makeApp(ports)).post(`/agent/${AGENT}/archive`)).status).toBe(403);
  });

  it("500s when the update throws", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.update).mockRejectedValue(new Error("pg down"));

    expect((await request(makeApp(ports)).post(`/agent/${AGENT}/archive`)).status).toBe(500);
  });
});

// ── GET /session/:shortId (+ /conversation) ──────────────────────────────

const SHORT_ID_ROUTES = [
  ["/session/abc123", getSessionByShortId],
  ["/session/abc123/conversation", getConversationByShortId],
] as const;

describe("short_id session routes", () => {
  it.each(SHORT_ID_ROUTES)("%s returns the row", async (path, fetch) => {
    const res = await request(makeApp()).get(path);

    expect(res.status).toBe(200);
    expect(vi.mocked(fetch).mock.calls[0]![1]).toBe("abc123");
  });

  it.each(SHORT_ID_ROUTES)("%s 404s a miss", async (path, fetch) => {
    vi.mocked(fetch).mockResolvedValueOnce(undefined as never);

    const res = await request(makeApp()).get(path);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("session_not_found");
  });

  it.each(SHORT_ID_ROUTES)("%s 409s an ambiguous prefix", async (path, fetch) => {
    vi.mocked(fetch).mockRejectedValueOnce(new AmbiguousShortIdError("abc123"));

    const res = await request(makeApp()).get(path);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ambiguous_short_id");
    expect(res.body.message).toContain("abc123");
  });

  it.each(SHORT_ID_ROUTES)("%s 500s on any other failure", async (path, fetch) => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("pg down"));

    expect((await request(makeApp()).get(path)).status).toBe(500);
  });
});

// ── GET /session/:id/tree ────────────────────────────────────────────────

describe("GET /session/:id/tree", () => {
  it("returns the tree when the caller owns the root session's agent", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports)).get("/session/sess_1/tree");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ root: "sess_1", nodes: [] });
    expect(vi.mocked(getSessionTree).mock.calls[0]![1]).toBe("sess_1");
  });

  it("400s an id that isn't a session id", async () => {
    // `/session/:shortId` also matches this shape, so the sess_ prefix
    // check is what keeps a short_id from reaching the tree query.
    const res = await request(makeApp()).get("/session/abc123/tree");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_session_id");
    expect(getSessionTree).not.toHaveBeenCalled();
  });

  it("404s an unknown session", async () => {
    vi.mocked(getSessionTree).mockResolvedValueOnce(undefined as never);

    const res = await request(makeApp()).get("/session/sess_x/tree");

    expect(res.status).toBe(404);
  });

  it.each([
    ["someone else's session", [{ owner_id: OTHER }]],
    ["a session whose owner row is gone", []],
  ])("404s %s rather than confirming it exists", async (_label, rows) => {
    const ports = makePorts({
      pool: { query: vi.fn(async () => ({ rows })) } as unknown as Pool,
    });

    const res = await request(makeApp(ports)).get("/session/sess_1/tree");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("session_not_found");
  });

  it("500s when the ownership query throws", async () => {
    const ports = makePorts({
      pool: {
        query: vi.fn(async () => {
          throw new Error("pg down");
        }),
      } as unknown as Pool,
    });

    expect((await request(makeApp(ports)).get("/session/sess_1/tree")).status).toBe(500);
  });
});

// ── GET /dashboard ───────────────────────────────────────────────────────

describe("GET /dashboard", () => {
  it("returns the summary", async () => {
    const res = await request(makeApp()).get("/dashboard");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tasks: 0 });
  });

  it("500s when the composer throws", async () => {
    vi.mocked(getDashboardSummary).mockRejectedValueOnce(new Error("pg down"));

    expect((await request(makeApp()).get("/dashboard")).status).toBe(500);
  });
});

// ── GET /memory/activity ─────────────────────────────────────────────────

describe("GET /memory/activity", () => {
  it("defaults to 12 weeks with no since", async () => {
    await request(makeApp()).get("/memory/activity");

    expect(vi.mocked(getMemoryActivity).mock.calls[0]![1]).toEqual({
      weeks: 12,
      since: undefined,
    });
  });

  it("passes through weeks and a well-formed since", async () => {
    await request(makeApp()).get("/memory/activity?weeks=4&since=2026-06-14");

    expect(vi.mocked(getMemoryActivity).mock.calls[0]![1]).toEqual({
      weeks: 4,
      since: "2026-06-14",
    });
  });

  it("treats a blank since as absent", async () => {
    await request(makeApp()).get("/memory/activity?weeks=&since=%20");

    expect(vi.mocked(getMemoryActivity).mock.calls[0]![1]).toEqual({
      weeks: 12,
      since: undefined,
    });
  });

  it.each(["2026", "0", "14-06-2026", "2026-13-45", "not-a-date"])(
    "400s a malformed since %j before it reaches Postgres",
    async (since) => {
      const res = await request(makeApp()).get(
        `/memory/activity?since=${encodeURIComponent(since)}`,
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_since");
      expect(getMemoryActivity).not.toHaveBeenCalled();
    },
  );

  it("500s when the composer throws", async () => {
    vi.mocked(getMemoryActivity).mockRejectedValueOnce(new Error("pg down"));

    expect((await request(makeApp()).get("/memory/activity")).status).toBe(500);
  });
});

// ── GET /mesh ────────────────────────────────────────────────────────────

describe("GET /mesh", () => {
  it.each(["24h", "7d", "30d", "all"])("passes through the %s window", async (window) => {
    await request(makeApp()).get(`/mesh?window=${window}`);

    expect(vi.mocked(getMeshOverview).mock.calls[0]![1]).toBe(window);
  });

  it.each(["", "1y", "99"])("falls back to the default window for %j", async (window) => {
    await request(makeApp()).get(`/mesh?window=${window}`);

    expect(vi.mocked(getMeshOverview).mock.calls[0]![1]).toBe("24h");
  });

  it("500s when the composer throws", async () => {
    vi.mocked(getMeshOverview).mockRejectedValueOnce(new Error("pg down"));

    expect((await request(makeApp()).get("/mesh")).status).toBe(500);
  });
});

// ── GET /promotion ───────────────────────────────────────────────────────

describe("GET /promotion", () => {
  it("scopes to the caller and passes a numeric limit", async () => {
    await request(makeApp()).get("/promotion?limit=5");

    expect(vi.mocked(listPromotions).mock.calls[0]![1]).toBe(PERSON);
    expect(vi.mocked(listPromotions).mock.calls[0]![2]).toEqual({ limit: 5 });
  });

  it("drops a non-numeric limit", async () => {
    await request(makeApp()).get("/promotion?limit=abc");

    expect(vi.mocked(listPromotions).mock.calls[0]![2]).toEqual({ limit: undefined });
  });

  it("passes an empty limit through as 0", async () => {
    // `Number("")` is 0, which is finite — so `?limit=` reaches the
    // composer as an explicit zero rather than falling back to the
    // default. Pinned as current behavior, not endorsed: unlike /inbox
    // and /activity this route has no lower-bound clamp.
    await request(makeApp()).get("/promotion?limit=");

    expect(vi.mocked(listPromotions).mock.calls[0]![2]).toEqual({ limit: 0 });
  });

  it("500s when the composer throws", async () => {
    vi.mocked(listPromotions).mockRejectedValueOnce(new Error("pg down"));

    expect((await request(makeApp()).get("/promotion")).status).toBe(500);
  });
});

// ── GET /memory/fact + counts ────────────────────────────────────────────

describe("GET /memory/fact", () => {
  it.each(["ic", "team", "org"])("passes through the %s scope", async (scope) => {
    await request(makeApp()).get(`/memory/fact?scope=${scope}`);

    expect(vi.mocked(listMemoryFacts).mock.calls[0]![2]).toMatchObject({ scope });
  });

  it("drops an unknown scope and a non-numeric limit", async () => {
    await request(makeApp()).get("/memory/fact?scope=galaxy&limit=lots");

    expect(vi.mocked(listMemoryFacts).mock.calls[0]![1]).toBe(PERSON);
    expect(vi.mocked(listMemoryFacts).mock.calls[0]![2]).toEqual({
      scope: undefined,
      limit: undefined,
    });
  });

  it("500s when the composer throws", async () => {
    vi.mocked(listMemoryFacts).mockRejectedValueOnce(new Error("pg down"));

    expect((await request(makeApp()).get("/memory/fact")).status).toBe(500);
  });
});

describe("GET /memory/fact/counts", () => {
  it("matches before /memory/fact/:id-style routes and scopes to the caller", async () => {
    const res = await request(makeApp()).get("/memory/fact/counts");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ic: 1 });
    expect(vi.mocked(listMemoryFactCounts).mock.calls[0]![1]).toBe(PERSON);
  });

  it("500s when the composer throws", async () => {
    vi.mocked(listMemoryFactCounts).mockRejectedValueOnce(new Error("pg down"));

    expect((await request(makeApp()).get("/memory/fact/counts")).status).toBe(500);
  });
});

// ── DELETE /memory/fact/:id ──────────────────────────────────────────────

describe("DELETE /memory/fact/:id", () => {
  it("deletes a fact belonging to an agent the caller owns", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports)).delete("/memory/fact/fact_1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, fact_id: "fact_1" });
    expect(ports.memoryFactRepo.delete).toHaveBeenCalledWith("fact_1");
  });

  it("404s an unknown fact", async () => {
    const ports = makePorts();
    vi.mocked(ports.memoryFactRepo.findById).mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).delete("/memory/fact/fact_x");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("fact_not_found");
    expect(ports.memoryFactRepo.delete).not.toHaveBeenCalled();
  });

  it.each([
    ["the owning agent belongs to someone else", fakeAgent({ owner_id: OTHER })],
    ["the owning agent is missing", undefined],
  ])("403s when %s", async (_label, agent) => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findById).mockResolvedValue(agent);

    const res = await request(makeApp(ports)).delete("/memory/fact/fact_1");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_owner");
    expect(ports.memoryFactRepo.delete).not.toHaveBeenCalled();
  });

  it("500s when the delete throws", async () => {
    const ports = makePorts();
    vi.mocked(ports.memoryFactRepo.delete).mockRejectedValue(new Error("pg down"));

    expect((await request(makeApp(ports)).delete("/memory/fact/fact_1")).status).toBe(500);
  });
});

// ── GET /work-product/:id ────────────────────────────────────────────────

describe("GET /work-product/:id", () => {
  it("returns the row", async () => {
    const res = await request(makeApp()).get("/work-product/wp_1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "wp_1" });
  });

  it("404s a miss", async () => {
    vi.mocked(getWorkProduct).mockResolvedValueOnce(undefined as never);

    const res = await request(makeApp()).get("/work-product/wp_x");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("work_product_not_found");
  });

  it("500s when the composer throws", async () => {
    vi.mocked(getWorkProduct).mockRejectedValueOnce(new Error("pg down"));

    expect((await request(makeApp()).get("/work-product/wp_1")).status).toBe(500);
  });
});

// ── GET /inbox and /activity ─────────────────────────────────────────────

describe("GET /inbox", () => {
  it("defaults the limit to 50", async () => {
    await request(makeApp()).get("/inbox");

    expect(vi.mocked(listInbox).mock.calls[0]![2]).toEqual({ limit: 50 });
  });

  it("honours a limit inside the 1..200 band", async () => {
    await request(makeApp()).get("/inbox?limit=200");

    expect(vi.mocked(listInbox).mock.calls[0]![2]).toEqual({ limit: 200 });
  });

  it.each(["0", "-5", "201", "abc"])("clamps an out-of-band limit %j to 50", async (limit) => {
    await request(makeApp()).get(`/inbox?limit=${limit}`);

    expect(vi.mocked(listInbox).mock.calls[0]![2]).toEqual({ limit: 50 });
  });

  it("500s when the composer throws", async () => {
    vi.mocked(listInbox).mockRejectedValueOnce(new Error("pg down"));

    expect((await request(makeApp()).get("/inbox")).status).toBe(500);
  });
});

describe("GET /activity", () => {
  it("defaults the limit to 20", async () => {
    await request(makeApp()).get("/activity");

    expect(vi.mocked(listActivity).mock.calls[0]![2]).toBe(20);
  });

  it("honours a limit inside the 1..100 band", async () => {
    await request(makeApp()).get("/activity?limit=100");

    expect(vi.mocked(listActivity).mock.calls[0]![2]).toBe(100);
  });

  it.each(["0", "-1", "101", "abc"])("clamps an out-of-band limit %j to 20", async (limit) => {
    await request(makeApp()).get(`/activity?limit=${limit}`);

    expect(vi.mocked(listActivity).mock.calls[0]![2]).toBe(20);
  });

  it("500s when the composer throws", async () => {
    vi.mocked(listActivity).mockRejectedValueOnce(new Error("pg down"));

    expect((await request(makeApp()).get("/activity")).status).toBe(500);
  });
});
