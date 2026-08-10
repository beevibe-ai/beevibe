/**
 * /repo-runs REST surface — unit tests with vitest fakes (no DB).
 *
 * The router is a thin closure over two ports, so a pair of `vi.fn()`
 * repos plus a stub auth middleware exercises every branch: the human
 * gate, transcript hydration from session_event, the terminal-status
 * guard on cancel, and the path-traversal guard on the artifact route.
 */
import express, { json } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type {
  RepoRun,
  RepoRunRepository,
  SessionEvent,
  SessionEventRepository,
} from "@beevibe/core";
import { createRepoRunsRouter } from "./repo-runs.js";

// ── Fakes ────────────────────────────────────────────────────────────────

const PERSON = "person_1";

function fakeRun(overrides: Partial<RepoRun> = {}): RepoRun {
  return {
    id: "run_1",
    agent_id: "agent_a",
    goal: "add a linter",
    repo_url: "https://github.com/acme/tool",
    status: "running",
    transcript: [],
    started_at: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  };
}

function fakeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: "ev_1",
    session_id: "sess_1",
    kind: "agent",
    content: "hello",
    created_at: new Date("2026-05-01T01:00:00Z"),
    ...overrides,
  };
}

function makeRepoRunRepo(): RepoRunRepository {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findBySessionId: vi.fn(),
    listRecent: vi.fn(),
    update: vi.fn(),
  };
}

function makeSessionEventRepo(): SessionEventRepository {
  return { append: vi.fn(), listBySession: vi.fn() };
}

/**
 * Stand-in for `createAuthMiddleware`. The real one resolves a bv_ token
 * against Postgres; these tests only care that handlers see the caller
 * shape `requireHuman` gates on, so the source is set per-app.
 */
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

function makeApp(
  repoRunRepo: RepoRunRepository,
  sessionEventRepo: SessionEventRepository,
  source: "human" | "agent" | "none" = "human",
) {
  const app = express();
  app.use(json());
  app.use(
    "/repo-runs",
    createRepoRunsRouter({
      authMiddleware: stubAuth(source),
      repoRunRepo,
      sessionEventRepo,
    }),
  );
  return app;
}

// Handlers log to console.error on the 500 paths; keep the suite output clean.
function silenceConsole() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

// ── GET /repo-runs ───────────────────────────────────────────────────────

describe("GET /repo-runs", () => {
  it("returns the last 50 runs", async () => {
    const runs = makeRepoRunRepo();
    const listed = [fakeRun(), fakeRun({ id: "run_2" })];
    vi.mocked(runs.listRecent).mockResolvedValue(listed);

    const res = await request(makeApp(runs, makeSessionEventRepo())).get("/repo-runs");

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(2);
    expect(runs.listRecent).toHaveBeenCalledWith({ limit: 50 });
  });

  it("403s an agent caller", async () => {
    const runs = makeRepoRunRepo();
    const res = await request(makeApp(runs, makeSessionEventRepo(), "agent")).get("/repo-runs");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
    expect(runs.listRecent).not.toHaveBeenCalled();
  });

  it("403s an unauthenticated caller", async () => {
    const res = await request(makeApp(makeRepoRunRepo(), makeSessionEventRepo(), "none")).get(
      "/repo-runs",
    );

    expect(res.status).toBe(403);
  });

  it("500s when the repo throws", async () => {
    silenceConsole();
    const runs = makeRepoRunRepo();
    vi.mocked(runs.listRecent).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(runs, makeSessionEventRepo())).get("/repo-runs");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("list_failed");
  });
});

// ── GET /repo-runs/:id ───────────────────────────────────────────────────

describe("GET /repo-runs/:id", () => {
  it("404s an unknown run", async () => {
    const runs = makeRepoRunRepo();
    vi.mocked(runs.findById).mockResolvedValue(undefined);

    const res = await request(makeApp(runs, makeSessionEventRepo())).get("/repo-runs/run_missing");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns the stored transcript when the run has no session", async () => {
    const runs = makeRepoRunRepo();
    const events = makeSessionEventRepo();
    vi.mocked(runs.findById).mockResolvedValue(
      fakeRun({ transcript: [{ at: "2026-05-01T00:00:00.000Z", kind: "log", text: "booted" }] }),
    );

    const res = await request(makeApp(runs, events)).get("/repo-runs/run_1");

    expect(res.status).toBe(200);
    expect(res.body.run.transcript).toEqual([
      { at: "2026-05-01T00:00:00.000Z", kind: "log", text: "booted" },
    ]);
    expect(events.listBySession).not.toHaveBeenCalled();
  });

  it("hydrates the transcript from session_event, inverting the daemon's kind mapping", async () => {
    const runs = makeRepoRunRepo();
    const events = makeSessionEventRepo();
    vi.mocked(runs.findById).mockResolvedValue(fakeRun({ session_id: "sess_1" }));
    vi.mocked(events.listBySession).mockResolvedValue([
      fakeEvent({ kind: "agent", content: "thinking" }),
      fakeEvent({ id: "ev_2", kind: "tool_call", content: "bash" }),
      fakeEvent({ id: "ev_3", kind: "tool_result", content: "boom" }),
      fakeEvent({ id: "ev_4", kind: "summary", content: "installed" }),
    ]);

    const res = await request(makeApp(runs, events)).get("/repo-runs/run_1");

    expect(res.status).toBe(200);
    // tool_result → error and summary → log is the inverse of the
    // daemon's mapKind; a regression here silently miscolors the UI.
    expect(res.body.run.transcript.map((e: { kind: string }) => e.kind)).toEqual([
      "agent",
      "tool_call",
      "error",
      "log",
    ]);
    expect(res.body.run.transcript[0]).toEqual({
      at: "2026-05-01T01:00:00.000Z",
      kind: "agent",
      text: "thinking",
    });
    expect(events.listBySession).toHaveBeenCalledWith("sess_1");
  });

  it("falls back to the stored transcript when hydration fails", async () => {
    silenceConsole();
    const runs = makeRepoRunRepo();
    const events = makeSessionEventRepo();
    vi.mocked(runs.findById).mockResolvedValue(
      fakeRun({
        session_id: "sess_1",
        transcript: [{ at: "2026-05-01T00:00:00.000Z", kind: "log", text: "stored" }],
      }),
    );
    vi.mocked(events.listBySession).mockRejectedValue(new Error("join failed"));

    const res = await request(makeApp(runs, events)).get("/repo-runs/run_1");

    expect(res.status).toBe(200);
    expect(res.body.run.transcript).toEqual([
      { at: "2026-05-01T00:00:00.000Z", kind: "log", text: "stored" },
    ]);
  });

  it("500s when the lookup throws", async () => {
    silenceConsole();
    const runs = makeRepoRunRepo();
    vi.mocked(runs.findById).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(runs, makeSessionEventRepo())).get("/repo-runs/run_1");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("get_failed");
  });

  it("403s an agent caller before touching the repo", async () => {
    const runs = makeRepoRunRepo();
    const res = await request(makeApp(runs, makeSessionEventRepo(), "agent")).get("/repo-runs/run_1");

    expect(res.status).toBe(403);
    expect(runs.findById).not.toHaveBeenCalled();
  });
});

// ── POST /repo-runs/:id/cancel ───────────────────────────────────────────

describe("POST /repo-runs/:id/cancel", () => {
  it("404s an unknown run", async () => {
    const runs = makeRepoRunRepo();
    vi.mocked(runs.findById).mockResolvedValue(undefined);

    const res = await request(makeApp(runs, makeSessionEventRepo())).post(
      "/repo-runs/run_x/cancel",
    );

    expect(res.status).toBe(404);
    expect(runs.update).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "failed", "blocked", "cancelled"] as const)(
    "409s a run already in terminal status %s",
    async (status) => {
      const runs = makeRepoRunRepo();
      vi.mocked(runs.findById).mockResolvedValue(fakeRun({ status }));

      const res = await request(makeApp(runs, makeSessionEventRepo())).post(
        "/repo-runs/run_1/cancel",
      );

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: "already_terminal", current_status: status });
      expect(runs.update).not.toHaveBeenCalled();
    },
  );

  it.each(["pending", "running"] as const)("cancels a %s run", async (status) => {
    const runs = makeRepoRunRepo();
    vi.mocked(runs.findById).mockResolvedValue(fakeRun({ status }));
    vi.mocked(runs.update).mockImplementation(async (_id, patch) =>
      fakeRun({ status: patch.status ?? status }),
    );

    const res = await request(makeApp(runs, makeSessionEventRepo())).post(
      "/repo-runs/run_1/cancel",
    );

    expect(res.status).toBe(200);
    expect(res.body.run.status).toBe("cancelled");
    const patch = vi.mocked(runs.update).mock.calls[0]![1];
    expect(patch.status).toBe("cancelled");
    expect(patch.ended_at).toBeInstanceOf(Date);
  });

  it("500s when the update throws", async () => {
    silenceConsole();
    const runs = makeRepoRunRepo();
    vi.mocked(runs.findById).mockResolvedValue(fakeRun({ status: "running" }));
    vi.mocked(runs.update).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(runs, makeSessionEventRepo())).post(
      "/repo-runs/run_1/cancel",
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("cancel_failed");
  });

  it("403s an agent caller", async () => {
    const runs = makeRepoRunRepo();
    const res = await request(makeApp(runs, makeSessionEventRepo(), "agent")).post(
      "/repo-runs/run_1/cancel",
    );

    expect(res.status).toBe(403);
    expect(runs.findById).not.toHaveBeenCalled();
  });
});

// ── GET /repo-runs/:id/artifacts/:file ───────────────────────────────────

describe("GET /repo-runs/:id/artifacts/:file", () => {
  it("404s an unknown run", async () => {
    const runs = makeRepoRunRepo();
    vi.mocked(runs.findById).mockResolvedValue(undefined);

    const res = await request(makeApp(runs, makeSessionEventRepo())).get(
      "/repo-runs/run_x/artifacts/report.md",
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("run_not_found");
  });

  it("rejects a filename that isn't its own basename", async () => {
    const runs = makeRepoRunRepo();
    vi.mocked(runs.findById).mockResolvedValue(fakeRun());

    // Express decodes %2F before the handler sees it, so this reaches
    // the basename() guard as a real traversal attempt rather than 404ing
    // on an unmatched route.
    const res = await request(makeApp(runs, makeSessionEventRepo())).get(
      "/repo-runs/run_1/artifacts/..%2F..%2Fetc%2Fpasswd",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_filename");
  });

  it("501s a well-formed request, pointing the caller at the work_product endpoint", async () => {
    const runs = makeRepoRunRepo();
    vi.mocked(runs.findById).mockResolvedValue(fakeRun({ task_id: "task_9" }));

    const res = await request(makeApp(runs, makeSessionEventRepo())).get(
      "/repo-runs/run_1/artifacts/report.md",
    );

    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ error: "not_implemented", task_id: "task_9" });
  });

  it("500s when the lookup throws", async () => {
    silenceConsole();
    const runs = makeRepoRunRepo();
    vi.mocked(runs.findById).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(runs, makeSessionEventRepo())).get(
      "/repo-runs/run_1/artifacts/report.md",
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("artifact_failed");
  });

  it("403s an agent caller", async () => {
    const runs = makeRepoRunRepo();
    const res = await request(makeApp(runs, makeSessionEventRepo(), "agent")).get(
      "/repo-runs/run_1/artifacts/report.md",
    );

    expect(res.status).toBe(403);
    expect(runs.findById).not.toHaveBeenCalled();
  });
});
