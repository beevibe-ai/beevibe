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
    findParent: vi.fn(),
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
  // Default: no prior session — fresh dispatch.
  vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue(undefined);
  // Intercept AgentSession.run so the dispatcher tests don't actually walk
  // the 7-step pipeline — we only care about the args.
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

const memAgentFactory = () =>
  vi.fn(() => ({
    prepareBriefing: vi.fn(),
    onTaskComplete: vi.fn(),
  }) as unknown as MemoryAgent);

describe("createTaskDispatcher (M6.5 ResumeReason)", () => {
  it("resolves runtime via registry keyed by agent.runtime_config.type", async () => {
    const codexRuntime = { ...fakeRuntime, type: "codex" } as AgentRuntime;
    const registry: RuntimeRegistry = {
      "claude-code": fakeRuntime,
      codex: codexRuntime,
    };

    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: memAgentFactory(),
    });

    const agent = makeAgent({ runtime_config: { type: "codex" } });
    await dispatch(makeTask(), agent, WORKSPACE, SIGNAL);

    const sessionInstance = runSpy.mock.instances[0] as AgentSession;
    expect(
      (sessionInstance as unknown as { deps: { runtime: AgentRuntime } }).deps
        .runtime,
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
    await expect(
      dispatch(makeTask(), agent, WORKSPACE, SIGNAL),
    ).rejects.toThrow(/Unsupported runtime: unknown-runtime/);
  });

  it("builds MemoryAgent with agent.id", async () => {
    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const makeMemoryAgent = memAgentFactory();
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent,
    });
    await dispatch(makeTask(), makeAgent({ id: "agent_XYZ" }), WORKSPACE, SIGNAL);
    expect(makeMemoryAgent).toHaveBeenCalledWith("agent_XYZ");
  });

  it("propagates onSessionComplete dep into AgentSession", async () => {
    const onSessionComplete = vi.fn().mockResolvedValue(undefined);
    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: memAgentFactory(),
      onSessionComplete,
    });
    await dispatch(makeTask(), makeAgent(), WORKSPACE, SIGNAL);

    const sessionInstance = runSpy.mock.instances[0] as AgentSession;
    expect(
      (sessionInstance as unknown as {
        deps: { onSessionComplete?: typeof onSessionComplete };
      }).deps.onSessionComplete,
    ).toBe(onSessionComplete);
  });

  it("fresh task (no prior session, no next_dispatch_context): reason=fresh, no priorSessionId, full body in envelope", async () => {
    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: memAgentFactory(),
    });

    const task = makeTask({
      id: "task_fresh",
      title: "Fix auth",
      description: "Find and fix the login bug.",
    });
    await dispatch(task, makeAgent(), WORKSPACE, SIGNAL);

    const arg = runSpy.mock.calls[0]![0] as Parameters<AgentSession["run"]>[0];
    expect(arg.taskId).toBe("task_fresh");
    expect(arg.priorSessionId).toBeUndefined();
    expect(arg.intent).toBe(
      '<task id="task_fresh">\nFix auth\n\nFind and fix the login bug.\n</task>',
    );
    expect(arg.intent).not.toContain("<context");
  });

  it("fresh task with no description: just title in envelope", async () => {
    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: memAgentFactory(),
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

  it("crash_recovery: no next_dispatch_context but prior session has cli_session_id → resumes with crash_recovery context", async () => {
    vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue({
      id: "sess_prior",
      agent_id: "agent_test",
      type: "task",
      status: "failed",
      intent: "x",
      cli_session_id: "cli_abc",
      created_at: new Date(),
    } as unknown as Session);

    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: memAgentFactory(),
    });

    const task = makeTask({ id: "task_crash" });
    await dispatch(task, makeAgent(), WORKSPACE, SIGNAL);

    const arg = runSpy.mock.calls[0]![0] as Parameters<AgentSession["run"]>[0];
    expect(arg.priorSessionId).toBe("sess_prior");
    expect(arg.intent).toContain('<context type="crash_recovery">');
    expect(arg.intent).toContain('<task id="task_crash"/>'); // self-closing on resume
    expect(arg.intent).not.toContain("Do a thing"); // body NOT included on non-fresh
  });

  it("cli_session_id guard: prior session without cli_session_id → falls through to fresh (no --resume)", async () => {
    vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue({
      id: "sess_prior_no_cli",
      agent_id: "agent_test",
      type: "task",
      status: "failed",
      intent: "x",
      cli_session_id: undefined, // crashed before CLI started
      created_at: new Date(),
    } as unknown as Session);

    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: memAgentFactory(),
    });

    await dispatch(makeTask({ id: "task_t" }), makeAgent(), WORKSPACE, SIGNAL);

    const arg = runSpy.mock.calls[0]![0] as Parameters<AgentSession["run"]>[0];
    expect(arg.priorSessionId).toBeUndefined();
    expect(arg.intent).not.toContain("<context");
  });

  it("revision (human + review): next_dispatch_context drives reason + prior_session_id, regardless of findLatestForTask", async () => {
    // Even though there's also a prior session in the DB, the explicit
    // next_dispatch_context.prior_session_id wins.
    vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue({
      id: "sess_other",
      agent_id: "agent_test",
      type: "task",
      status: "succeeded",
      intent: "x",
      cli_session_id: "cli_other",
      created_at: new Date(),
    } as unknown as Session);

    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: memAgentFactory(),
    });

    const task = makeTask({
      id: "task_rev",
      status: "revision",
      next_dispatch_context: {
        kind: "revision",
        feedback: "Please add error handling.",
        source: "human",
        from_status: "review",
        prior_session_id: "sess_explicit",
      },
    });
    await dispatch(task, makeAgent(), WORKSPACE, SIGNAL);

    const arg = runSpy.mock.calls[0]![0] as Parameters<AgentSession["run"]>[0];
    expect(arg.priorSessionId).toBe("sess_explicit"); // override beats findLatestForTask
    expect(arg.intent).toContain(
      '<context type="revision" source="human" from="review">',
    );
    expect(arg.intent).toContain("A human reviewer requested changes");
    expect(arg.intent).toContain("Please add error handling.");
    expect(arg.intent).toContain('<task id="task_rev"/>');
  });

  it("revision (parent_agent + blocked): post-blocker preamble + reviser_agent_id in context", async () => {
    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: memAgentFactory(),
    });

    const task = makeTask({
      id: "task_blocked_rev",
      next_dispatch_context: {
        kind: "revision",
        feedback: "Use the existing connection pool.",
        source: "parent_agent",
        from_status: "blocked",
        reviser_agent_id: "agent_parent",
        prior_session_id: "sess_lower_first",
      },
    });
    await dispatch(task, makeAgent(), WORKSPACE, SIGNAL);

    const arg = runSpy.mock.calls[0]![0] as Parameters<AgentSession["run"]>[0];
    expect(arg.priorSessionId).toBe("sess_lower_first");
    expect(arg.intent).toContain(
      '<context type="revision" source="parent_agent" from="blocked">',
    );
    expect(arg.intent).toContain(
      "Your parent agent has resolved the blocker you reported",
    );
  });

  it("post_escalation initiator: explicit prior_session_id + post-escalation context", async () => {
    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: memAgentFactory(),
    });

    const task = makeTask({
      id: "task_a",
      next_dispatch_context: {
        kind: "post_escalation",
        role: "initiator",
        resolution: {
          title: "Hybrid approach",
          description: "Reuse X but rewrite Y.",
          source: "human",
        },
        notes: "Cap timeline at 4 weeks.",
        prior_session_id: "sess_a_pre_escalation",
      },
    });
    await dispatch(task, makeAgent(), WORKSPACE, SIGNAL);

    const arg = runSpy.mock.calls[0]![0] as Parameters<AgentSession["run"]>[0];
    expect(arg.priorSessionId).toBe("sess_a_pre_escalation");
    expect(arg.intent).toContain(
      '<context type="post_escalation" role="initiator">',
    );
    expect(arg.intent).toContain("Hybrid approach — Reuse X but rewrite Y.");
    expect(arg.intent).toContain("Cap timeline at 4 weeks");
    expect(arg.intent).toContain("Continue your task using this resolution.");
  });

  it("post_escalation counterparty (synthetic task — no findLatestForTask hit): explicit prior_session_id wins", async () => {
    // For B's synthetic task, sessionRepo.findLatestForTask returns undefined
    // (the synthetic task has no own prior session). Explicit context value
    // is what enables --resume to S_B.
    vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue(undefined);

    const registry: RuntimeRegistry = { "claude-code": fakeRuntime };
    const dispatch = createTaskDispatcher({
      agentRepo,
      sessionRepo,
      runtimeRegistry: registry,
      makeMemoryAgent: memAgentFactory(),
    });

    const task = makeTask({
      id: "task_b_synth",
      next_dispatch_context: {
        kind: "post_escalation",
        role: "counterparty",
        resolution: {
          title: "Approach A",
          description: "...",
          source: "initiator",
          source_index: 0,
        },
        prior_session_id: "sess_b_pre_escalation",
      },
    });
    await dispatch(task, makeAgent(), WORKSPACE, SIGNAL);

    const arg = runSpy.mock.calls[0]![0] as Parameters<AgentSession["run"]>[0];
    expect(arg.priorSessionId).toBe("sess_b_pre_escalation");
    expect(arg.intent).toContain('role="counterparty"');
    expect(arg.intent).toContain("Update your memory with anything notable");
  });
});
