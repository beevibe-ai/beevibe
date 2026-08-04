/**
 * Tests for the /capabilities router.
 *
 * Every collaborator is injected, so the router mounts against a bare
 * Express app with stub repos — no database. The interesting surface is
 * the authorization ladder on `referenced-repos` (human-only, task must
 * exist, caller must own it directly or via the creating agent) and the
 * validation + error mapping on `POST /use`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { json, type RequestHandler } from "express";
import request from "supertest";
import { createCapabilitiesRouter } from "./capabilities.js";

const { getReferencedRepos, useRepoHandler, createUseRepoTool } = vi.hoisted(() => {
  const useRepoHandler = vi.fn();
  return {
    getReferencedRepos: vi.fn(),
    useRepoHandler,
    createUseRepoTool: vi.fn(() => ({ handler: useRepoHandler })),
  };
});

vi.mock("@beevibe/core/services/referenced-repos", () => ({ getReferencedRepos }));
vi.mock("../tools/use-repo.js", () => ({ createUseRepoTool }));

const PERSON = "per_alice";

/**
 * Auth middleware stand-in — attaches whatever caller the test wants.
 * `null` leaves `req.caller` unset, standing in for an unauthenticated
 * request that somehow reached the router.
 */
function callerAs(caller: unknown): RequestHandler {
  return (req, _res, next) => {
    if (caller !== null) (req as { caller?: unknown }).caller = caller;
    next();
  };
}

const humanCaller = { source: "human", personId: PERSON };
const agentCaller = { source: "agent", personId: PERSON, agentId: "agt_1" };

interface Stubs {
  taskFindById: ReturnType<typeof vi.fn>;
  agentFindById: ReturnType<typeof vi.fn>;
  agentFindTopLevel: ReturnType<typeof vi.fn>;
}

function makeApp(caller: unknown = humanCaller): { app: express.Express } & Stubs {
  const taskFindById = vi.fn();
  const agentFindById = vi.fn();
  const agentFindTopLevel = vi.fn();

  const router = createCapabilitiesRouter({
    authMiddleware: callerAs(caller),
    agentRepo: {
      findById: agentFindById,
      findTopLevelForOwner: agentFindTopLevel,
    } as never,
    taskRepo: { findById: taskFindById } as never,
    sessionRepo: {} as never,
    sessionEventRepo: {} as never,
    workProductRepo: {} as never,
    repoRunRepo: {} as never,
    learnedSkillRepo: {} as never,
    dispatchService: {} as never,
  });

  const app = express();
  app.use(json());
  app.use("/capabilities", router);
  return { app, taskFindById, agentFindById, agentFindTopLevel };
}

/** Task created directly by the calling human. */
const ownTask = {
  id: "tsk_1",
  creator_id: PERSON,
  creator_type: "human",
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  createUseRepoTool.mockReturnValue({ handler: useRepoHandler });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("GET /capabilities/referenced-repos — auth", () => {
  it("rejects a non-human caller with 403", async () => {
    const { app, taskFindById } = makeApp(agentCaller);
    const res = await request(app)
      .get("/capabilities/referenced-repos")
      .query({ task_id: "tsk_1" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
    expect(taskFindById).not.toHaveBeenCalled();
  });

  it("rejects a request with no caller at all", async () => {
    const { app } = makeApp(null);
    const res = await request(app)
      .get("/capabilities/referenced-repos")
      .query({ task_id: "tsk_1" });
    expect(res.status).toBe(403);
  });
});

describe("GET /capabilities/referenced-repos — validation", () => {
  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("400s when task_id is %s", async (_label, taskId) => {
    const { app, taskFindById } = makeApp();
    const req = request(app).get("/capabilities/referenced-repos");
    const res = await (taskId === undefined ? req : req.query({ task_id: taskId }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_task_id");
    expect(taskFindById).not.toHaveBeenCalled();
  });

  it("trims the task_id before looking it up", async () => {
    const { app, taskFindById } = makeApp();
    taskFindById.mockResolvedValue(ownTask);
    getReferencedRepos.mockResolvedValue([]);
    await request(app)
      .get("/capabilities/referenced-repos")
      .query({ task_id: "  tsk_1  " });
    expect(taskFindById).toHaveBeenCalledWith("tsk_1");
  });

  it("404s when the task does not exist", async () => {
    const { app, taskFindById } = makeApp();
    taskFindById.mockResolvedValue(null);
    const res = await request(app)
      .get("/capabilities/referenced-repos")
      .query({ task_id: "tsk_gone" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("task_not_found");
  });
});

describe("GET /capabilities/referenced-repos — ownership", () => {
  it("allows a task the caller created directly", async () => {
    const { app, taskFindById, agentFindById } = makeApp();
    taskFindById.mockResolvedValue(ownTask);
    getReferencedRepos.mockResolvedValue([{ url: "https://github.com/a/b" }]);

    const res = await request(app)
      .get("/capabilities/referenced-repos")
      .query({ task_id: "tsk_1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ repos: [{ url: "https://github.com/a/b" }] });
    // Direct ownership short-circuits the agent lookup.
    expect(agentFindById).not.toHaveBeenCalled();
  });

  it("allows any agent-created task without an ownership lookup", async () => {
    const { app, taskFindById, agentFindById } = makeApp();
    taskFindById.mockResolvedValue({
      id: "tsk_2",
      creator_id: "agt_other",
      creator_type: "agent",
    });
    getReferencedRepos.mockResolvedValue([]);

    const res = await request(app)
      .get("/capabilities/referenced-repos")
      .query({ task_id: "tsk_2" });

    expect(res.status).toBe(200);
    expect(agentFindById).not.toHaveBeenCalled();
  });

  it("403s when another human created the task and no agent backs the id", async () => {
    const { app, taskFindById, agentFindById } = makeApp();
    taskFindById.mockResolvedValue({
      id: "tsk_3",
      creator_id: "per_bob",
      creator_type: "human",
    });
    agentFindById.mockResolvedValue(null);

    const res = await request(app)
      .get("/capabilities/referenced-repos")
      .query({ task_id: "tsk_3" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_owner");
    expect(getReferencedRepos).not.toHaveBeenCalled();
  });

  it("403s when the creating agent belongs to a different owner", async () => {
    const { app, taskFindById, agentFindById } = makeApp();
    taskFindById.mockResolvedValue({
      id: "tsk_4",
      creator_id: "agt_bob",
      creator_type: "system",
    });
    agentFindById.mockResolvedValue({ id: "agt_bob", owner_id: "per_bob" });

    const res = await request(app)
      .get("/capabilities/referenced-repos")
      .query({ task_id: "tsk_4" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_owner");
  });

  it("allows a task whose creating agent the caller owns", async () => {
    const { app, taskFindById, agentFindById } = makeApp();
    taskFindById.mockResolvedValue({
      id: "tsk_5",
      creator_id: "agt_mine",
      creator_type: "system",
    });
    agentFindById.mockResolvedValue({ id: "agt_mine", owner_id: PERSON });
    getReferencedRepos.mockResolvedValue([]);

    const res = await request(app)
      .get("/capabilities/referenced-repos")
      .query({ task_id: "tsk_5" });

    expect(res.status).toBe(200);
  });

  it("scopes the repo scan to the task and the calling person", async () => {
    const { app, taskFindById } = makeApp();
    taskFindById.mockResolvedValue(ownTask);
    getReferencedRepos.mockResolvedValue([]);

    await request(app)
      .get("/capabilities/referenced-repos")
      .query({ task_id: "tsk_1" });

    expect(getReferencedRepos).toHaveBeenCalledWith(
      "tsk_1",
      PERSON,
      expect.objectContaining({
        sessionRepo: expect.anything(),
        sessionEventRepo: expect.anything(),
        workProductRepo: expect.anything(),
        learnedSkillRepo: expect.anything(),
      }),
    );
  });

  it("500s with scan_failed when the scan throws", async () => {
    const { app, taskFindById } = makeApp();
    taskFindById.mockResolvedValue(ownTask);
    getReferencedRepos.mockRejectedValue(new Error("transcript unavailable"));

    const res = await request(app)
      .get("/capabilities/referenced-repos")
      .query({ task_id: "tsk_1" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("scan_failed");
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("POST /capabilities/use", () => {
  const body = { repo_url: "https://github.com/a/b", goal: "add tests" };

  it("rejects a non-human caller with 403", async () => {
    const { app, agentFindTopLevel } = makeApp(agentCaller);
    const res = await request(app).post("/capabilities/use").send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
    expect(agentFindTopLevel).not.toHaveBeenCalled();
  });

  it.each([
    ["repo_url is missing", { goal: "add tests" }, "missing_repo_url"],
    ["repo_url is blank", { repo_url: "  ", goal: "add tests" }, "missing_repo_url"],
    ["repo_url is not a string", { repo_url: 42, goal: "g" }, "missing_repo_url"],
    ["goal is missing", { repo_url: "https://github.com/a/b" }, "missing_goal"],
    ["goal is blank", { repo_url: "https://github.com/a/b", goal: " " }, "missing_goal"],
  ])("400s when %s", async (_label, payload, error) => {
    const { app, agentFindTopLevel } = makeApp();
    const res = await request(app).post("/capabilities/use").send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(agentFindTopLevel).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const { app, agentFindTopLevel } = makeApp();
    agentFindTopLevel.mockResolvedValue(null);
    const res = await request(app).post("/capabilities/use").send(body);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_agent");
    expect(agentFindTopLevel).toHaveBeenCalledWith(PERSON);
  });

  it("202s with the tool's payload and runs under the primary agent", async () => {
    const { app, agentFindTopLevel } = makeApp();
    agentFindTopLevel.mockResolvedValue({ id: "agt_top" });
    useRepoHandler.mockResolvedValue({
      isError: false,
      content: { repo_run_id: "rr_1", watch_url: "/runs/rr_1" },
    });

    const res = await request(app).post("/capabilities/use").send(body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ repo_run_id: "rr_1", watch_url: "/runs/rr_1" });
    expect(createUseRepoTool).toHaveBeenCalledWith(
      { agentId: "agt_top" },
      expect.objectContaining({ agentRepo: expect.anything() }),
    );
    expect(useRepoHandler).toHaveBeenCalledWith({
      goal: "add tests",
      repo_url: "https://github.com/a/b",
    });
  });

  it("trims repo_url and goal before handing them to the tool", async () => {
    const { app, agentFindTopLevel } = makeApp();
    agentFindTopLevel.mockResolvedValue({ id: "agt_top" });
    useRepoHandler.mockResolvedValue({ isError: false, content: {} });

    await request(app)
      .post("/capabilities/use")
      .send({ repo_url: "  https://github.com/a/b  ", goal: "  add tests  " });

    expect(useRepoHandler).toHaveBeenCalledWith({
      goal: "add tests",
      repo_url: "https://github.com/a/b",
    });
  });

  it("maps a tool-level error to 400 and forwards its content", async () => {
    const { app, agentFindTopLevel } = makeApp();
    agentFindTopLevel.mockResolvedValue({ id: "agt_top" });
    useRepoHandler.mockResolvedValue({
      isError: true,
      content: { error: "repo_unreachable" },
    });

    const res = await request(app).post("/capabilities/use").send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "repo_unreachable" });
  });

  it("500s with use_failed when the tool throws", async () => {
    const { app, agentFindTopLevel } = makeApp();
    agentFindTopLevel.mockResolvedValue({ id: "agt_top" });
    useRepoHandler.mockRejectedValue(new Error("dispatch down"));

    const res = await request(app).post("/capabilities/use").send(body);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("use_failed");
    expect(errorSpy).toHaveBeenCalled();
  });
});
