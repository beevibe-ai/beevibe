/**
 * Tests for the /find-repo router — the HTTP wrapper around the
 * `find_repo` ranker. Pure DI, so it mounts on a bare Express app with
 * a stubbed agent repo and a mocked tool factory.
 *
 * The logic worth pinning down is the `limit` coercion (string query
 * param → clamped integer, with a default when absent or unparseable)
 * and the error mapping around the tool call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type RequestHandler } from "express";
import request from "supertest";
import { createFindRepoRouter } from "./find-repo.js";

const { findRepoHandler, createFindRepoTool } = vi.hoisted(() => {
  const findRepoHandler = vi.fn();
  return {
    findRepoHandler,
    createFindRepoTool: vi.fn(() => ({ handler: findRepoHandler })),
  };
});

vi.mock("../tools/find-repo.js", () => ({ createFindRepoTool }));

const PERSON = "per_alice";
const humanCaller = { source: "human", personId: PERSON };

function callerAs(caller: unknown): RequestHandler {
  return (req, _res, next) => {
    if (caller !== null) (req as { caller?: unknown }).caller = caller;
    next();
  };
}

function makeApp(caller: unknown = humanCaller) {
  const agentFindTopLevel = vi.fn();
  const router = createFindRepoRouter({
    authMiddleware: callerAs(caller),
    agentRepo: { findTopLevelForOwner: agentFindTopLevel } as never,
    learnedSkillRepo: {} as never,
    embeddings: {} as never,
  });
  const app = express();
  app.use("/find-repo", router);
  return { app, agentFindTopLevel };
}

/** App with a resolved primary agent and a successful ranker. */
function makeReadyApp() {
  const ctx = makeApp();
  ctx.agentFindTopLevel.mockResolvedValue({ id: "agt_top" });
  findRepoHandler.mockResolvedValue({ isError: false, content: { repos: [] } });
  return ctx;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  createFindRepoTool.mockReturnValue({ handler: findRepoHandler });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("GET /find-repo — auth and validation", () => {
  it("rejects a non-human caller with 403", async () => {
    const { app, agentFindTopLevel } = makeApp({
      source: "agent",
      personId: PERSON,
    });
    const res = await request(app).get("/find-repo").query({ goal: "add tests" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
    expect(agentFindTopLevel).not.toHaveBeenCalled();
  });

  it("rejects a request with no caller", async () => {
    const { app } = makeApp(null);
    const res = await request(app).get("/find-repo").query({ goal: "add tests" });
    expect(res.status).toBe(403);
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("400s when goal is %s", async (_label, goal) => {
    const { app, agentFindTopLevel } = makeApp();
    const req = request(app).get("/find-repo");
    const res = await (goal === undefined ? req : req.query({ goal }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_goal");
    expect(agentFindTopLevel).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const { app, agentFindTopLevel } = makeApp();
    agentFindTopLevel.mockResolvedValue(null);
    const res = await request(app).get("/find-repo").query({ goal: "add tests" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_agent");
    expect(agentFindTopLevel).toHaveBeenCalledWith(PERSON);
  });
});

describe("GET /find-repo — limit coercion", () => {
  it.each([
    ["defaults to 5 when absent", undefined, 5],
    ["passes a valid limit through", "3", 3],
    ["clamps above the max", "999", 10],
    ["clamps below the min", "0", 1],
    ["clamps a negative", "-4", 1],
    ["floors a fractional limit", "3.9", 3],
    ["falls back to 5 when unparseable", "abc", 5],
  ])("%s", async (_label, limit, expected) => {
    const { app } = makeReadyApp();
    const req = request(app).get("/find-repo");
    await (limit === undefined
      ? req.query({ goal: "add tests" })
      : req.query({ goal: "add tests", limit }));
    expect(findRepoHandler).toHaveBeenCalledWith({ goal: "add tests", limit: expected });
  });
});

describe("GET /find-repo — ranker call", () => {
  it("200s with the ranker payload and runs under the primary agent", async () => {
    const { app } = makeReadyApp();
    findRepoHandler.mockResolvedValue({
      isError: false,
      content: { repos: [{ url: "https://github.com/a/b", score: 0.9 }] },
    });

    const res = await request(app).get("/find-repo").query({ goal: "add tests" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ repos: [{ url: "https://github.com/a/b", score: 0.9 }] });
    expect(createFindRepoTool).toHaveBeenCalledWith(
      { agentId: "agt_top" },
      expect.objectContaining({ embeddings: expect.anything() }),
    );
  });

  it("trims the goal before handing it to the ranker", async () => {
    const { app } = makeReadyApp();
    await request(app).get("/find-repo").query({ goal: "  add tests  " });
    expect(findRepoHandler).toHaveBeenCalledWith({ goal: "add tests", limit: 5 });
  });

  it("maps a tool-level error to 400 and forwards its content", async () => {
    const { app } = makeReadyApp();
    findRepoHandler.mockResolvedValue({
      isError: true,
      content: { error: "embeddings_unavailable" },
    });
    const res = await request(app).get("/find-repo").query({ goal: "add tests" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "embeddings_unavailable" });
  });

  it("500s with search_failed when the ranker throws", async () => {
    const { app } = makeReadyApp();
    findRepoHandler.mockRejectedValue(new Error("index down"));
    const res = await request(app).get("/find-repo").query({ goal: "add tests" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("search_failed");
    expect(errorSpy).toHaveBeenCalled();
  });
});
