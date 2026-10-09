/**
 * `watch_tasks` + `unwatch` tools — unit tests with a fake WatchService.
 *
 * Both are thin adapters, so what's tested here is exactly the adapter's
 * job: normalizing agent-supplied input before it reaches the service,
 * and mapping the service's typed errors onto distinct tool error codes.
 * Getting the mapping wrong matters — an agent that sees `watch_error`
 * instead of `watch_validation` can't tell "fix your input" from "retry
 * later", and a missing `sessionId` guard would register a watch with no
 * waiter to wake.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

const AGENT = "agent_a";
const SESSION = "sess_1";

function harness(opts: { ctx?: Partial<WatchToolContext> } = {}) {
  const watchService = {
    watchTasks: vi.fn().mockResolvedValue({ watchId: "watch_1", firedImmediately: false }),
    unwatch: vi.fn().mockResolvedValue(undefined),
  };
  const [watchTasks, unwatch] = buildWatchTools(
    { agentId: AGENT, sessionId: SESSION, ...opts.ctx },
    { watchService: watchService as unknown as WatchService },
  );
  return { watchTasks: watchTasks!, unwatch: unwatch!, watchService };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { watchTasks, unwatch } = harness();
    expect(watchTasks.name).toBe("watch_tasks");
    expect(unwatch.name).toBe("unwatch");
  });

  it("advertises the real mode list in the schema enum", () => {
    const { watchTasks } = harness();
    const schema = watchTasks.schema as {
      properties: { mode: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.mode.enum).toEqual(["all", "any"]);
    expect(schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks input normalization", () => {
  it("passes task_ids through with the caller's agent and session", async () => {
    const { watchTasks, watchService } = harness();
    const res = await watchTasks.handler({ task_ids: ["task_1", "task_2"] });

    expect(watchService.watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      callerSessionId: SESSION,
      taskIds: ["task_1", "task_2"],
      // Defaults to the conservative "wait for everything".
      mode: "all",
      reason: undefined,
    });
    expect(res.content).toEqual({ watch_id: "watch_1", fired_immediately: false });
    expect(res.isError).toBeUndefined();
  });

  it("reports fired_immediately when the condition was already met", async () => {
    const { watchTasks, watchService } = harness();
    watchService.watchTasks.mockResolvedValue({
      watchId: "watch_2",
      firedImmediately: true,
    });
    const res = await watchTasks.handler({ task_ids: ["task_1"] });
    expect(res.content).toEqual({ watch_id: "watch_2", fired_immediately: true });
  });

  it("honors an explicit mode", async () => {
    const { watchTasks, watchService } = harness();
    await watchTasks.handler({ task_ids: ["task_1"], mode: "any" });
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "any" }),
    );
  });

  it("falls back to 'all' for an unrecognized mode instead of erroring", async () => {
    const { watchTasks, watchService } = harness();
    for (const mode of ["sometimes", "", 1, null, ["any"]]) {
      await watchTasks.handler({ task_ids: ["task_1"], mode });
    }
    for (const call of watchService.watchTasks.mock.calls) {
      expect((call[0] as { mode: string }).mode).toBe("all");
    }
  });

  it("drops non-string members from task_ids", async () => {
    const { watchTasks, watchService } = harness();
    await watchTasks.handler({ task_ids: ["task_1", 42, null, "task_2", {}] });
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["task_1", "task_2"] }),
    );
  });

  it("rejects a missing, non-array, or empty task_ids", async () => {
    const { watchTasks, watchService } = harness();
    for (const task_ids of [undefined, [], "task_1", {}, null, [42, null]]) {
      const res = await watchTasks.handler({ task_ids });
      expect(res.isError).toBe(true);
      expect(res.content).toMatchObject({ error: "watch_validation" });
    }
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("trims a reason and drops a blank one", async () => {
    const { watchTasks, watchService } = harness();
    await watchTasks.handler({ task_ids: ["task_1"], reason: "  check the build  " });
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "check the build" }),
    );

    watchService.watchTasks.mockClear();
    for (const reason of ["", "   ", 42, null]) {
      await watchTasks.handler({ task_ids: ["task_1"], reason });
    }
    for (const call of watchService.watchTasks.mock.calls) {
      expect((call[0] as { reason?: string }).reason).toBeUndefined();
    }
  });

  it("refuses to register a watch with no session to wake", async () => {
    const { watchTasks, watchService } = harness({ ctx: { sessionId: undefined } });
    const res = await watchTasks.handler({ task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect((res.content as { message: string }).message).toContain("session context");
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });
});

describe("unwatch", () => {
  it("cancels by id for the calling agent", async () => {
    const { unwatch, watchService } = harness();
    const res = await unwatch.handler({ watch_id: "watch_1" });
    expect(watchService.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      watchId: "watch_1",
    });
    expect(res.content).toEqual({ ok: true });
    expect(res.isError).toBeUndefined();
  });

  it("rejects a missing or non-string watch_id", async () => {
    const { unwatch, watchService } = harness();
    for (const watch_id of [undefined, "", 42, null, {}]) {
      const res = await unwatch.handler({ watch_id });
      expect(res.isError).toBe(true);
      expect(res.content).toMatchObject({ error: "watch_validation" });
    }
    expect(watchService.unwatch).not.toHaveBeenCalled();
  });
});

describe("watch error mapping", () => {
  const cases = [
    { err: new WatchAuthError("not your task"), code: "watch_auth" },
    { err: new WatchValidationError("too many tasks"), code: "watch_validation" },
    { err: new WatchNotFoundError("watch_9"), code: "watch_not_found" },
    { err: new Error("pg down"), code: "watch_error" },
  ];

  it.each(cases)("maps $err.name to $code on watch_tasks", async ({ err, code }) => {
    const { watchTasks, watchService } = harness();
    watchService.watchTasks.mockRejectedValue(err);
    const res = await watchTasks.handler({ task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: code, message: err.message });
  });

  it.each(cases)("maps $err.name to $code on unwatch", async ({ err, code }) => {
    const { unwatch, watchService } = harness();
    watchService.unwatch.mockRejectedValue(err);
    const res = await unwatch.handler({ watch_id: "watch_1" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: code, message: err.message });
  });

  it("stringifies a non-Error throw rather than losing it", async () => {
    const { watchTasks, watchService } = harness();
    watchService.watchTasks.mockRejectedValue("kaboom");
    const res = await watchTasks.handler({ task_ids: ["task_1"] });
    expect(res.content).toMatchObject({ error: "watch_error", message: "kaboom" });
  });

  it("keeps WatchNotFoundError's id in the message", async () => {
    const { unwatch, watchService } = harness();
    watchService.unwatch.mockRejectedValue(new WatchNotFoundError("watch_9"));
    const res = await unwatch.handler({ watch_id: "watch_9" });
    expect((res.content as { message: string }).message).toContain("watch_9");
  });
});
