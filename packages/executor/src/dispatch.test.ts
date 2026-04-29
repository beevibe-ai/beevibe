import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  AgentRuntime,
  RuntimeRegistry,
  Session,
  SessionRepository,
  Task,
  Workspace,
} from "@beevibe/core";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import { AgentSession } from "@beevibe/core/services/agent-session";
import { createTaskDispatcher } from "./dispatch.js";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_test",
    name: "Agent",
    owner_id: "person_owner",
    hierarchy_level: "ic",
    api_key: "bv_a_k",
    runtime_config: { type: "claude-code" },
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_test",
    title: "Do a thing",
    status: "assigned",
    priority: "medium",
    creator_id: "person_owner",
    creator_type: "person",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

const WORKSPACE: Workspace = { path: "/tmp/ws" };
const SIGNAL = new AbortController().signal;

let agentRepo: AgentRepository;
let sessionRepo: SessionRepository;
let fakeRuntime: AgentRuntime;
let runSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  agentRepo = {
    findById: vi.fn(),
    findByApiKey: vi.fn(),
    findByOwnerId: vi.fn(),
    findTopLevelForOwner: vi.fn(),
    findSubordinates: vi.fn(),
    findPeers: vi.fn(),
    findByLevel: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  sessionRepo = {
    findById: vi.fn(),
    findLatestForTask: vi.fn(),
    listForTask: vi.fn(),
    listForAgent: vi.fn(),
    countRunningByAgent: vi.fn(),
    listRunningWithPid: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  fakeRuntime = {
    type: "claude-code",
    execute: vi.fn(),
    healthCheck: vi.fn(),
    shutdown: vi.fn(),
  };
  // Intercept AgentSession.run so the dispatcher tests don't actually walk the
  // 6-step pipeline — we only care that run() gets called with the right args.
  runSpy = vi
    .spyOn(AgentSession.prototype, "run")
    .mockResolvedValue({
      id: "sess_1",
      agent_id: "agent_test",
      type: "task",
      status: "succeeded",
      intent: "x",
      created_at: new Date(),
    } as unknown as Session);
});

describe("createTaskDispatcher", () => {
  it("resolves runtime via registry keyed by agent.runtime_config.type", async () => {
    const codexRuntime = { ...fakeRuntime, type: "codex" } as AgentRuntime;
    const registry: RuntimeRegistry = {
      "claude-code": fakeRuntime,
      codex: codexRuntime,
    };
    const makeMemoryAgent = vi.fn(() => ({
      prepareBriefing: vi.fn(),
      onTaskComplete: vi.fn(),
    }) as unknown as MemoryAgent);

    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent,
    });

    const agent = makeAgent({ runtime_config: { type: "codex" } });
    await dispatch(makeTask(), agent, WORKSPACE, SIGNAL);

    // AgentSession ctor saw the codex runtime.
    // The spy was set on AgentSession.prototype.run, so we can introspect via
    // the `this` the call was made on.
    const sessionInstance = runSpy.mock.instances[0] as AgentSession;
    expect(
      (sessionInstance as unknown as { deps: { runtime: AgentRuntime } }).deps.runtime,
    ).toBe(codexRuntime);
  });

  it("throws 'Unsupported runtime: X' when agent's runtime type is not registered", async () => {
    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: vi.fn(),
    });
    const agent = makeAgent({ runtime_config: { type: "unknown-runtime" } });
    await expect(dispatch(makeTask(), agent, WORKSPACE, SIGNAL)).rejects.toThrow(
      /Unsupported runtime: unknown-runtime/,
    );
  });

  it("builds MemoryAgent with agent.id", async () => {
    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const makeMemoryAgent = vi.fn(() => ({
      prepareBriefing: vi.fn(),
      onTaskComplete: vi.fn(),
    }) as unknown as MemoryAgent);
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent,
    });
    await dispatch(makeTask(), makeAgent({ id: "agent_XYZ" }), WORKSPACE, SIGNAL);
    expect(makeMemoryAgent).toHaveBeenCalledWith("agent_XYZ");
  });

  it("calls AgentSession.run with { agentId, taskId, intent (<task id> envelope around title+description), workspace, abortSignal }", async () => {
    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: vi.fn(() => ({
        prepareBriefing: vi.fn(),
        onTaskComplete: vi.fn(),
      }) as unknown as MemoryAgent),
    });

    const agent = makeAgent({ id: "agent_run" });
    const task = makeTask({
      id: "task_run",
      title: "Fix auth",
      description: "Find and fix the login bug.",
    });
    await dispatch(task, agent, WORKSPACE, SIGNAL);

    const arg = runSpy.mock.calls[0]![0] as Parameters<AgentSession["run"]>[0];
    expect(arg.agentId).toBe("agent_run");
    expect(arg.taskId).toBe("task_run");
    // M6.3: stdin payload wraps body in <task id="..."/> envelope. The system
    // prompt (briefing) stays cache-friendly — task-specific data lives here.
    expect(arg.intent).toBe(
      '<task id="task_run">\nFix auth\n\nFind and fix the login bug.\n</task>',
    );
    expect(arg.workspace).toBe(WORKSPACE);
    expect(arg.abortSignal).toBe(SIGNAL);
    // No urgency field — M5.0 dropped it.
    expect(arg).not.toHaveProperty("urgency");
  });

  it("intent is just the title in the envelope when description is missing", async () => {
    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: vi.fn(() => ({
        prepareBriefing: vi.fn(),
        onTaskComplete: vi.fn(),
      }) as unknown as MemoryAgent),
    });
    await dispatch(
      makeTask({ id: "task_t", title: "just a title", description: undefined }),
      makeAgent(),
      WORKSPACE,
      SIGNAL,
    );
    const arg = runSpy.mock.calls[0]![0] as Parameters<AgentSession["run"]>[0];
    expect(arg.intent).toBe('<task id="task_t">\njust a title\n</task>');
  });

  it("task in `revision` (post-claim re-work): looks up latest prior session and passes priorSessionId", async () => {
    vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue({
      id: "sess_prior",
      agent_id: "agent_test",
      type: "task",
      status: "failed",
      intent: "x",
      created_at: new Date(),
    } as unknown as Session);

    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: vi.fn(() => ({
        prepareBriefing: vi.fn(),
        onTaskComplete: vi.fn(),
      }) as unknown as MemoryAgent),
    });

    const task = makeTask({ id: "task_rev", status: "revision" });
    await dispatch(task, makeAgent(), WORKSPACE, SIGNAL);

    expect(sessionRepo.findLatestForTask).toHaveBeenCalledWith("task_rev");
    const arg = runSpy.mock.calls[0]![0] as Parameters<AgentSession["run"]>[0];
    expect(arg.priorSessionId).toBe("sess_prior");
  });

  it("fresh (in_progress) task: does NOT call findLatestForTask + priorSessionId is undefined", async () => {
    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: vi.fn(() => ({
        prepareBriefing: vi.fn(),
        onTaskComplete: vi.fn(),
      }) as unknown as MemoryAgent),
    });
    // Post-claim status for fresh work is `in_progress`; dispatch must not
    // trigger the --resume path for this.
    await dispatch(makeTask({ status: "in_progress" }), makeAgent(), WORKSPACE, SIGNAL);
    expect(sessionRepo.findLatestForTask).not.toHaveBeenCalled();
    const arg = runSpy.mock.calls[0]![0] as Parameters<AgentSession["run"]>[0];
    expect(arg.priorSessionId).toBeUndefined();
  });
});
