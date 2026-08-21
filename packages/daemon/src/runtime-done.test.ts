import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api-client.js";
import { reportDone } from "./runtime-done.js";

function makeApi(post = vi.fn(async () => ({ status: 204, body: undefined }))) {
  return { api: { post } as unknown as ApiClient, post };
}

/** Everything the logger passed after its leading timestamp argument. */
function logged(spy: ReturnType<typeof vi.spyOn>, call = 0): unknown[] {
  return (spy.mock.calls[call] ?? []).slice(1);
}

describe("reportDone", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("logs one success line and posts the body verbatim", async () => {
    const { api, post } = makeApi();
    const done = { session_id: "sess_1", status: "succeeded" as const, exit_code: 0 };

    await reportDone(api, done, { tag: "daemon/spawn", succeeded: "exit=0" });

    expect(logged(logSpy)).toEqual(["[daemon/spawn] sess=sess_1 exit=0"]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith("/runtime/done", done);
  });

  it("reports a non-success through error(), with the status and the extra field", async () => {
    const { api } = makeApi();

    await reportDone(
      api,
      { session_id: "sess_2", status: "failed" },
      { tag: "daemon/spawn", succeeded: "exit=0", failed: "exit=127" },
    );

    expect(logSpy).not.toHaveBeenCalled();
    expect(logged(errorSpy)).toEqual(["[daemon/spawn] sess=sess_2 status=failed exit=127"]);
  });

  it("indents a multi-line diagnostic under an error: label", async () => {
    const { api } = makeApi();

    await reportDone(
      api,
      { session_id: "sess_3", status: "failed" },
      {
        tag: "daemon/repo-run",
        succeeded: "ok",
        errorDetail: "boom\n  at frame",
      },
    );

    expect(logged(errorSpy)).toEqual([
      "[daemon/repo-run] sess=sess_3 status=failed\n  error:\n    boom\n      at frame",
    ]);
  });

  it("omits the error block entirely when there is no diagnostic", async () => {
    const { api } = makeApi();

    await reportDone(
      api,
      { session_id: "sess_4", status: "cancelled" },
      { tag: "daemon/spawn", succeeded: "exit=0" },
    );

    expect(logged(errorSpy)).toEqual(["[daemon/spawn] sess=sess_4 status=cancelled"]);
  });

  it("swallows a failed POST — the run it describes is already over", async () => {
    const post = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const { api } = makeApi(post as unknown as ReturnType<typeof makeApi>["post"]);

    await expect(
      reportDone(
        api,
        { session_id: "sess_5", status: "succeeded" },
        { tag: "daemon/spawn", succeeded: "exit=0" },
      ),
    ).resolves.toBeUndefined();

    expect(logged(errorSpy)).toEqual([
      "[daemon/spawn] /runtime/done POST failed:",
      "connection reset",
    ]);
  });
});
