import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunState, TranscriptEvent } from "@beevibe/sandbox/orchestrator";
import type { ApiClient } from "./api-client.js";
import { runRepoDispatch } from "./repo-runs.js";
import type { DispatchPayload } from "./spawner.js";

const { runRepoAgentMock } = vi.hoisted(() => ({ runRepoAgentMock: vi.fn() }));

vi.mock("@beevibe/sandbox/orchestrator", () => ({ runRepoAgent: runRepoAgentMock }));
vi.mock("./logger.js", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

function payload(overrides: Partial<DispatchPayload> = {}): DispatchPayload {
  return {
    session_id: "sess_1",
    agent_id: "agent_1",
    agent_api_key: "bv_a_test",
    agent_hierarchy_level: "ic",
    runtime_type: "claude",
    intent: "borrow a repo",
    system_prompt_append: "",
    env: {},
    type: "run_repo",
    mcp_server_url: "http://api.test/mcp",
    run_repo: {
      repo_run_id: "rr_1",
      repo_url: "https://github.com/acme/tool",
      goal: "convert the PDF",
    },
    ...overrides,
  };
}

function event(kind: TranscriptEvent["kind"], text: string): TranscriptEvent {
  return { at: "2026-01-01T00:00:00.000Z", kind, text };
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: "rr_1",
    status: "succeeded",
    repo_url: "https://github.com/acme/tool",
    goal: "convert the PDF",
    started_at: "2026-01-01T00:00:00.000Z",
    transcript: [],
    artifacts: [],
    ...overrides,
  };
}

interface Post {
  path: string;
  body: Record<string, unknown>;
}

function fakeApi(): { api: ApiClient; posts: Post[] } {
  const posts: Post[] = [];
  const post = vi.fn(async (path: string, body: unknown) => {
    posts.push({ path, body: body as Record<string, unknown> });
    return { status: 200, body: undefined };
  });
  return { api: { post } as unknown as ApiClient, posts };
}

/** Every event the batcher pushed to /runtime/events, in order. */
function eventsFrom(posts: Post[]): Array<{ kind: string; content: string }> {
  return posts
    .filter((p) => p.path === "/runtime/events")
    .flatMap((p) => p.body.events as Array<{ kind: string; content: string }>);
}

function doneFrom(posts: Post[]): Record<string, unknown> {
  const done = posts.find((p) => p.path === "/runtime/done");
  if (!done) throw new Error("no /runtime/done POST was made");
  return done.body;
}

/** Make the mocked orchestrator replay `transcript` through on_state in slices. */
function replay(transcript: TranscriptEvent[], slices: number[], result: RunState) {
  runRepoAgentMock.mockImplementation(
    async (opts: { on_state?: (s: RunState) => void }) => {
      for (const upTo of slices) {
        opts.on_state?.(runState({ transcript: transcript.slice(0, upTo) }));
      }
      return result;
    },
  );
}

beforeEach(() => {
  runRepoAgentMock.mockReset();
  runRepoAgentMock.mockResolvedValue(runState());
});

describe("runRepoDispatch", () => {
  it("rejects a dispatch that is missing its run_repo block", async () => {
    const { api } = fakeApi();

    await expect(
      runRepoDispatch({ api }, payload({ run_repo: undefined })),
    ).rejects.toThrow(/missing payload\.run_repo/);
    expect(runRepoAgentMock).not.toHaveBeenCalled();
  });

  it("hands the run_repo block to the orchestrator, defaulting the wall clock to 20 minutes", async () => {
    const { api } = fakeApi();

    await runRepoDispatch({ api }, payload());

    expect(runRepoAgentMock.mock.calls[0]?.[0]).toMatchObject({
      run_id: "rr_1",
      repo_url: "https://github.com/acme/tool",
      goal: "convert the PDF",
      max_runtime_seconds: 20 * 60,
    });
  });

  it("converts the wall-clock limit from minutes to seconds", async () => {
    const { api } = fakeApi();

    await runRepoDispatch(
      { api },
      payload({
        run_repo: {
          repo_run_id: "rr_1",
          repo_url: "https://github.com/acme/tool",
          goal: "convert the PDF",
          limits: { wall_clock_minutes: 5 },
        },
      }),
    );

    expect(runRepoAgentMock.mock.calls[0]?.[0]).toMatchObject({
      max_runtime_seconds: 300,
    });
  });

  it("maps orchestrator transcript kinds onto session event kinds", async () => {
    const { api, posts } = fakeApi();
    replay(
      [
        event("agent", "thinking"),
        event("tool_call", "sandbox_exec({\"cmd\":\"ls\"})"),
        event("log", "container ready"),
        event("error", "exit 1"),
      ],
      [4],
      runState(),
    );

    await runRepoDispatch({ api }, payload());

    expect(eventsFrom(posts)).toEqual([
      { session_id: "sess_1", kind: "agent", content: "thinking" },
      {
        session_id: "sess_1",
        kind: "tool_call",
        content: "sandbox_exec({\"cmd\":\"ls\"})",
      },
      { session_id: "sess_1", kind: "summary", content: "container ready" },
      { session_id: "sess_1", kind: "tool_result", content: "exit 1" },
    ]);
  });

  it("sends each transcript entry once even though on_state replays the whole transcript", async () => {
    const { api, posts } = fakeApi();
    replay(
      [event("agent", "one"), event("agent", "two"), event("agent", "three")],
      [1, 2, 3],
      runState(),
    );

    await runRepoDispatch({ api }, payload());

    expect(eventsFrom(posts).map((e) => e.content)).toEqual(["one", "two", "three"]);
  });

  it("captures install commands and the last non-install exec as the invocation", async () => {
    const { api, posts } = fakeApi();
    replay(
      [
        event("tool_call", 'sandbox_exec({"cmd":"pip install pdfplumber"})'),
        event("tool_call", 'sandbox_exec({"cmd":"git clone https://x/y"})'),
        event("tool_call", 'sandbox_exec({"cmd":"python convert.py in.pdf"})'),
      ],
      [1, 3],
      runState(),
    );

    await runRepoDispatch({ api }, payload());

    expect(doneFrom(posts).run_repo).toMatchObject({
      install_log: "pip install pdfplumber\ngit clone https://x/y",
      invocation: "python convert.py in.pdf",
    });
  });

  it("leaves install_log and invocation unset when no exec tool calls happened", async () => {
    const { api, posts } = fakeApi();
    replay([event("agent", "nothing to run")], [1], runState());

    await runRepoDispatch({ api }, payload());

    const runRepo = doneFrom(posts).run_repo as Record<string, unknown>;
    expect(runRepo.install_log).toBeUndefined();
    expect(runRepo.invocation).toBeUndefined();
  });

  it("ignores tool calls that are not sandbox_exec", async () => {
    const { api, posts } = fakeApi();
    replay(
      [event("tool_call", 'sandbox_export_artifact({"sandbox_path":"/out.csv"})')],
      [1],
      runState(),
    );

    await runRepoDispatch({ api }, payload());

    const runRepo = doneFrom(posts).run_repo as Record<string, unknown>;
    expect(runRepo.install_log).toBeUndefined();
    expect(runRepo.invocation).toBeUndefined();
  });

  it.each([
    { status: "succeeded", expected: "succeeded" },
    { status: "blocked", expected: "failed" },
    { status: "failed", expected: "failed" },
    { status: "running", expected: "failed" },
  ] as const)(
    "reports orchestrator status '$status' as session status '$expected'",
    async ({ status, expected }) => {
      const { api, posts } = fakeApi();
      runRepoAgentMock.mockResolvedValue(
        runState({ status, error: status === "succeeded" ? undefined : "boom" }),
      );

      await runRepoDispatch({ api }, payload());

      expect(doneFrom(posts).status).toBe(expected);
    },
  );

  it("summarizes a successful run by artifact count and forwards the artifacts", async () => {
    const { api, posts } = fakeApi();
    runRepoAgentMock.mockResolvedValue(
      runState({
        artifacts: [
          {
            filename: "out.csv",
            title: "Extracted table",
            size_bytes: 42,
            host_path: "/host/out.csv",
            sandbox_path: "/sandbox/artifacts/out.csv",
          },
        ],
      }),
    );

    await runRepoDispatch({ api }, payload());

    const done = doneFrom(posts);
    expect(done.result_summary).toBe("Exported 1 artifact.");
    expect((done.run_repo as { artifacts: unknown[] }).artifacts).toEqual([
      {
        filename: "out.csv",
        title: "Extracted table",
        size_bytes: 42,
        host_path: "/host/out.csv",
        sandbox_path: "/sandbox/artifacts/out.csv",
      },
    ]);
  });

  it("pluralizes the artifact summary", async () => {
    const { api, posts } = fakeApi();
    runRepoAgentMock.mockResolvedValue(
      runState({
        artifacts: [
          { filename: "a.csv", title: "A", size_bytes: 1, host_path: "/h/a.csv" },
          { filename: "b.csv", title: "B", size_bytes: 2, host_path: "/h/b.csv" },
        ],
      }),
    );

    await runRepoDispatch({ api }, payload());

    expect(doneFrom(posts).result_summary).toBe("Exported 2 artifacts.");
  });

  it("uses the orchestrator error as the summary when the run did not succeed", async () => {
    const { api, posts } = fakeApi();
    runRepoAgentMock.mockResolvedValue(
      runState({ status: "blocked", error: "could not install pdfplumber" }),
    );

    await runRepoDispatch({ api }, payload());

    expect(doneFrom(posts)).toMatchObject({
      status: "failed",
      result_summary: "could not install pdfplumber",
      error: "could not install pdfplumber",
    });
  });

  it("falls back to a generic summary when a failed run reports no error", async () => {
    const { api, posts } = fakeApi();
    runRepoAgentMock.mockResolvedValue(runState({ status: "failed" }));

    await runRepoDispatch({ api }, payload());

    expect(doneFrom(posts).result_summary).toBe("Run did not produce an artifact.");
  });

  it("notes cancellation in the transcript when the abort signal has fired", async () => {
    const { api, posts } = fakeApi();
    const controller = new AbortController();
    controller.abort();
    replay([event("agent", "working")], [1], runState());

    await runRepoDispatch({ api }, payload(), controller.signal);

    expect(eventsFrom(posts)).toContainEqual({
      session_id: "sess_1",
      kind: "summary",
      content: "[run cancelled by user]",
    });
  });

  it("flushes the transcript before reporting done", async () => {
    const { api, posts } = fakeApi();
    replay([event("agent", "working")], [1], runState());

    await runRepoDispatch({ api }, payload());

    expect(posts.map((p) => p.path)).toEqual(["/runtime/events", "/runtime/done"]);
  });

  it("does not throw when the /runtime/done POST fails — the run is already over", async () => {
    const post = vi.fn(async (path: string) => {
      if (path === "/runtime/done") throw new Error("connection reset");
      return { status: 200, body: undefined };
    });
    const api = { post } as unknown as ApiClient;

    await expect(runRepoDispatch({ api }, payload())).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledWith("/runtime/done", expect.anything());
  });
});
