/**
 * Tests for the approve / reject pair on the /task router.
 *
 * `task.test.ts` covers these end-to-end, but it is DB-gated — it needs
 * `DATABASE_URL_TEST` and skips wholesale without one, which left the two
 * handlers with no coverage in a bare checkout. Both now share one
 * `reviewRoute` factory, so this pins the behavior that factory has to keep:
 * the auth gate, the optional `result_summary` parse, which `TaskService`
 * verb each verb-route calls, the response projection, and the error mapping.
 *
 * Every collaborator is injected, so the router mounts against a bare
 * Express app with stubs — no database.
 */
import { describe, it, expect, vi } from "vitest";
import express, { json, type RequestHandler } from "express";
import request from "supertest";
import {
  InvalidTaskTransitionError,
  TaskNotFoundError,
} from "@beevibe/core/services/task-service";
import { createTaskRouter } from "./task.js";

const PERSON = "per_alice";
const humanCaller = { source: "human", personId: PERSON };

/** Auth middleware stand-in — attaches whatever caller the test wants. */
function callerAs(caller: unknown): RequestHandler {
  return (req, _res, next) => {
    if (caller !== null) (req as { caller?: unknown }).caller = caller;
    next();
  };
}

function makeApp(caller: unknown = humanCaller) {
  const approveTask = vi.fn();
  const rejectTask = vi.fn();

  const router = createTaskRouter({
    authMiddleware: callerAs(caller),
    taskService: { approveTask, rejectTask } as never,
    // Untouched by approve/reject. The capability repos are deliberately
    // omitted, which makes `recordCapabilityOutcome` a no-op — that branch is
    // already covered where it's wired.
    taskRepo: {} as never,
    sessionRepo: {} as never,
    runtimeRepo: {} as never,
    dispatchService: {} as never,
    hub: {} as never,
    pool: {} as never,
  });

  const app = express();
  app.use(json());
  app.use("/task", router);
  return { app, approveTask, rejectTask };
}

// Both routes run the same factory, so each behavior is asserted against
// both verbs rather than trusting that approve's pass implies reject's.
const VERBS = [
  { verb: "approve", service: "approveTask" },
  { verb: "reject", service: "rejectTask" },
] as const;

describe.each(VERBS)("POST /task/:id/$verb", ({ verb, service }) => {
  it("calls the matching TaskService verb and projects id + status", async () => {
    const app = makeApp();
    app[service].mockResolvedValue({
      id: "task_1",
      status: verb === "approve" ? "done" : "cancelled",
      // Extra columns must NOT leak — the response is a two-field projection.
      description: "secret",
    });

    const res = await request(app.app)
      .post(`/task/task_1/${verb}`)
      .send({ result_summary: "looks good" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      task: { id: "task_1", status: verb === "approve" ? "done" : "cancelled" },
    });
    expect(app[service]).toHaveBeenCalledWith("task_1", "looks good");
    // The sibling verb must not have fired.
    const other = service === "approveTask" ? "rejectTask" : "approveTask";
    expect(app[other]).not.toHaveBeenCalled();
  });

  it("passes result_summary as undefined when absent or not a string", async () => {
    for (const body of [{}, { result_summary: 42 }, { result_summary: null }]) {
      const app = makeApp();
      app[service].mockResolvedValue({ id: "task_1", status: "done" });

      const res = await request(app.app).post(`/task/task_1/${verb}`).send(body);

      expect(res.status).toBe(200);
      expect(app[service]).toHaveBeenCalledWith("task_1", undefined);
    }
  });

  it("403s a non-human caller without touching the service", async () => {
    const app = makeApp({ source: "agent", personId: PERSON, agentId: "agt_1" });

    const res = await request(app.app).post(`/task/task_1/${verb}`).send({});

    expect(res.status).toBe(403);
    expect(app[service]).not.toHaveBeenCalled();
  });

  it("maps TaskNotFoundError to 404", async () => {
    const app = makeApp();
    app[service].mockRejectedValue(new TaskNotFoundError("task_gone"));

    const res = await request(app.app).post(`/task/task_gone/${verb}`).send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("task_not_found");
  });

  it("maps InvalidTaskTransitionError to 409", async () => {
    const app = makeApp();
    app[service].mockRejectedValue(
      new InvalidTaskTransitionError(`cannot ${verb} task in status 'done'`),
    );

    const res = await request(app.app).post(`/task/task_1/${verb}`).send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_transition");
  });

  it("maps an unexpected throw to 500", async () => {
    const app = makeApp();
    // Suppress the handler's own console.error for this expected path.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    app[service].mockRejectedValue(new Error("boom"));

    const res = await request(app.app).post(`/task/task_1/${verb}`).send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    spy.mockRestore();
  });
});
