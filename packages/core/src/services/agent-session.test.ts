import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../domain/agent.js";
import type { Session } from "../domain/session.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type {
  AgentRuntime,
  RuntimeResult,
  Workspace,
} from "../ports/runtime.js";
import type { SessionRepository } from "../ports/session-repo.js";
import type { SessionEventRepository } from "../ports/session-event-repo.js";
import {
  AgentSession,
  type AgentSessionDeps,
  buildIntent,
  type IntentTask,
  type ResumeReason,
} from "./agent-session.js";
import type { MemoryAgent } from "./memory/memory-agent.js";

const WORKSPACE: Workspace = { path: "/tmp/ws" };

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_1",
    name: "A",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude", model: "claude-opus-4-7" },
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    agent_id: "agent_1",
    type: "task",
    status: "running",
    intent: "do stuff",
    created_at: new Date(),
    ...overrides,
  };
}

function makeRuntimeResult(overrides: Partial<RuntimeResult> = {}): RuntimeResult {
  return {
    status: "completed",
    output: "ok",
    cli_session_id: "cli_123",
    process_pid: 1234,
    process_group_id: 1234,
    usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001, model: "claude-opus-4-7" },
    ...overrides,
  };
}

let agentRepo: AgentRepository;
let sessionRepo: SessionRepository;
let sessionEventRepo: SessionEventRepository;
let runtime: AgentRuntime;
let memoryAgent: MemoryAgent;
let service: AgentSession;

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
  sessionEventRepo = {
    append: vi.fn<SessionEventRepository["append"]>().mockResolvedValue({
      id: "evt_test",
      session_id: "sess_test",
      kind: "tool_call",
      content: "",
      created_at: new Date(),
    }),
    listBySession: vi.fn<SessionEventRepository["listBySession"]>().mockResolvedValue([]),
  };
  runtime = {
    type: "fake",
    execute: vi.fn(),
    healthCheck: vi.fn(),
    shutdown: vi.fn(),
  };
  memoryAgent = {
    prepareBriefing: vi.fn(),
    searchArchival: vi.fn<MemoryAgent["searchArchival"]>().mockResolvedValue(""),
    // Default to a resolved promise so the fire-and-forget .catch() has something to chain.
    onTaskComplete: vi.fn<MemoryAgent["onTaskComplete"]>().mockResolvedValue(),
  };
  service = new AgentSession({ agentRepo, sessionRepo, sessionEventRepo, runtime, memoryAgent });
});

describe("AgentSession.run", () => {
  it("threads briefing + baseline into system_prompt_append and marks session succeeded", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(
      makeAgent({
        runtime_config: {
          type: "claude",
          model: "claude-opus-4-7",
          system_prompt_addition: "Follow the house style.",
        },
      }),
    );
    vi.mocked(sessionRepo.create).mockImplementation(async (input) =>
      makeSession(input.id),
    );
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue({
      systemPromptAppend: "<core_memory></core_memory>",
      userMessagePrefix: "<archival_memory><fact>relevant fact</fact></archival_memory>",
      snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] },
    });
    vi.mocked(runtime.execute).mockResolvedValue(makeRuntimeResult());
    vi.mocked(sessionRepo.update).mockImplementation(async (id, patch) =>
      makeSession(id, patch as Partial<Session>),
    );

    const out = await service.run({
      agentId: "agent_1",
      intent: "Reply with 'ok'.",
      workspace: WORKSPACE,
      taskId: "task_1",
    });

    expect(memoryAgent.prepareBriefing).toHaveBeenCalledWith("Reply with 'ok'.");
    const ctx = vi.mocked(runtime.execute).mock.calls[0]![0];
    // System prompt has FOUR pieces, in cache-stable order:
    //   1. BEEVIBE_LIFECYCLE_REMINDER_TASK (always-on; M9.5+ empirical fix)
    //   2. BEEVIBE_MEMORY_REMINDER (always-on; Letta pattern for active
    //      mid-session memory management)
    //   3. agent.runtime_config.system_prompt_addition (per-agent baseline)
    //   4. briefing.systemPromptAppend (= core_memory; M9.4)
    expect(ctx.system_prompt_append).toContain("<beevibe_lifecycle>");
    expect(ctx.system_prompt_append).toContain("mcp__beevibe__update_progress");
    expect(ctx.system_prompt_append).toContain("<beevibe_memory>");
    expect(ctx.system_prompt_append).toContain("mcp__beevibe__save_memory");
    expect(ctx.system_prompt_append).toContain("mcp__beevibe__update_core_memory");
    expect(ctx.system_prompt_append).toContain("Follow the house style.");
    expect(ctx.system_prompt_append).toContain("<core_memory></core_memory>");
    // Reminders must come BEFORE the persona baseline (cache order).
    const lifecycleIdx = ctx.system_prompt_append.indexOf("<beevibe_lifecycle>");
    const memoryIdx = ctx.system_prompt_append.indexOf("<beevibe_memory>");
    const baselineIdx = ctx.system_prompt_append.indexOf("Follow the house style.");
    expect(lifecycleIdx).toBeLessThan(memoryIdx);
    expect(memoryIdx).toBeLessThan(baselineIdx);
    expect(ctx.workspace).toBe(WORKSPACE);
    // M9.4: archival_memory is prepended to the user message (intent).
    expect(ctx.intent).toBe(
      "<archival_memory><fact>relevant fact</fact></archival_memory>\n\nReply with 'ok'.",
    );

    // Terminal state written
    const updatePatch = vi
      .mocked(sessionRepo.update)
      .mock.calls.find((c) => (c[1] as { status?: string }).status === "succeeded");
    expect(updatePatch).toBeDefined();
    expect(updatePatch![1].cli_session_id).toBe("cli_123");
    expect(updatePatch![1].usage?.input_tokens).toBe(10);
    expect(updatePatch![1].exit_code).toBe(0);

    expect(out.status).toBe("succeeded");
  });

  it("creates the session row BEFORE calling runtime.execute (so onSpawn has an id)", async () => {
    const createdIds: string[] = [];
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.create).mockImplementation(async (input) => {
      createdIds.push(input.id);
      return makeSession(input.id);
    });
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue({ systemPromptAppend: "", userMessagePrefix: "", snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] } });
    vi.mocked(runtime.execute).mockImplementation(async (ctx) => {
      // session should already exist by now — prove it by asserting the onSpawn update lands
      ctx.onSpawn?.({ process_pid: 99, process_group_id: 99 });
      return makeRuntimeResult();
    });
    vi.mocked(sessionRepo.update).mockImplementation(async (id) => makeSession(id));

    await service.run({
      agentId: "agent_1",
      intent: "x",
      workspace: WORKSPACE,
    });

    const spawnUpdate = vi
      .mocked(sessionRepo.update)
      .mock.calls.find(
        (c) => (c[1] as { process_pid?: number }).process_pid === 99,
      );
    expect(spawnUpdate).toBeDefined();
    expect(spawnUpdate![0]).toBe(createdIds[0]);
  });

  it("maps runtime status 'cancelled' → session.status 'cancelled'", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.create).mockImplementation(async (i) => makeSession(i.id));
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue({ systemPromptAppend: "", userMessagePrefix: "", snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] } });
    vi.mocked(runtime.execute).mockResolvedValue(
      makeRuntimeResult({ status: "cancelled", output: "Session cancelled." }),
    );
    vi.mocked(sessionRepo.update).mockImplementation(async (id, patch) =>
      makeSession(id, patch as Partial<Session>),
    );

    const out = await service.run({
      agentId: "agent_1",
      intent: "x",
      workspace: WORKSPACE,
    });
    expect(out.status).toBe("cancelled");
  });

  it("sets session to 'failed' and rethrows when runtime throws", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.create).mockImplementation(async (i) => makeSession(i.id));
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue({ systemPromptAppend: "", userMessagePrefix: "", snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] } });
    vi.mocked(runtime.execute).mockRejectedValue(new Error("spawn ENOENT"));
    vi.mocked(sessionRepo.update).mockImplementation(async (id, patch) =>
      makeSession(id, patch as Partial<Session>),
    );

    await expect(
      service.run({
        agentId: "agent_1",
        intent: "x",
          workspace: WORKSPACE,
      }),
    ).rejects.toThrow(/spawn ENOENT/);

    const failPatch = vi
      .mocked(sessionRepo.update)
      .mock.calls.find((c) => (c[1] as { status?: string }).status === "failed");
    expect(failPatch).toBeDefined();
    expect(failPatch![1].error).toContain("spawn ENOENT");
  });

  it("fires onSessionComplete with the failed row when the runtime throws", async () => {
    // Spawn/CLI exceptions used to skip the hook — only graceful failures
    // fired it — which left mesh resolvers waiting out the 5-min timeout.
    // Verifies the in-catch fire so failResolverForCalleeSession runs fast.
    const onSessionComplete = vi
      .fn<NonNullable<AgentSessionDeps["onSessionComplete"]>>()
      .mockResolvedValue();
    const local = new AgentSession({
      agentRepo,
      sessionRepo,
      sessionEventRepo,
      runtime,
      memoryAgent,
      onSessionComplete,
    });
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.create).mockImplementation(async (i) => makeSession(i.id));
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue({
      systemPromptAppend: "",
      userMessagePrefix: "",
      snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] },
    });
    vi.mocked(runtime.execute).mockRejectedValue(new Error("spawn ENOENT"));
    vi.mocked(sessionRepo.update).mockImplementation(async (id, patch) =>
      makeSession(id, patch as Partial<Session>),
    );

    await expect(
      local.run({ agentId: "agent_1", intent: "x", workspace: WORKSPACE }),
    ).rejects.toThrow(/spawn ENOENT/);

    // Allow the fire-and-forget hook to settle before asserting.
    await new Promise((r) => setImmediate(r));
    expect(onSessionComplete).toHaveBeenCalledTimes(1);
    expect(onSessionComplete.mock.calls[0]![0].status).toBe("failed");
    expect(onSessionComplete.mock.calls[0]![0].error).toContain("spawn ENOENT");
  });

  it("passes agent.runtime_config.model + max_turns into RuntimeContext (per-agent override)", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(
      makeAgent({
        runtime_config: {
          type: "claude",
          model: "claude-haiku-4-5",
          max_turns: 7,
        },
      }),
    );
    vi.mocked(sessionRepo.create).mockImplementation(async (i) => makeSession(i.id));
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue({ systemPromptAppend: "", userMessagePrefix: "", snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] } });
    vi.mocked(runtime.execute).mockResolvedValue(makeRuntimeResult());
    vi.mocked(sessionRepo.update).mockImplementation(async (id) => makeSession(id));

    await service.run({
      agentId: "agent_1",
      intent: "x",
      workspace: WORKSPACE,
    });
    const ctx = vi.mocked(runtime.execute).mock.calls[0]![0];
    expect(ctx.model).toBe("claude-haiku-4-5");
    expect(ctx.max_turns).toBe(7);
  });

  it("passes BEEVIBE_SESSION_ID via RuntimeContext.env (agent id rides on the bv_ token, not env)", async () => {
    let capturedSessionId = "";
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.create).mockImplementation(async (input) => {
      capturedSessionId = input.id;
      return makeSession(input.id);
    });
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue({ systemPromptAppend: "", userMessagePrefix: "", snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] } });
    vi.mocked(runtime.execute).mockResolvedValue(makeRuntimeResult());
    vi.mocked(sessionRepo.update).mockImplementation(async (id) => makeSession(id));

    await service.run({
      agentId: "agent_1",
      intent: "x",
      workspace: WORKSPACE,
    });

    const ctx = vi.mocked(runtime.execute).mock.calls[0]![0];
    expect(ctx.env).toEqual({ BEEVIBE_SESSION_ID: capturedSessionId });
  });

  it("resolves --resume via priorSessionId's cli_session_id", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.findById).mockResolvedValue(
      makeSession("sess_prev", { cli_session_id: "cli_prev_abc" }),
    );
    vi.mocked(sessionRepo.create).mockImplementation(async (i) => makeSession(i.id));
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue({ systemPromptAppend: "", userMessagePrefix: "", snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] } });
    vi.mocked(runtime.execute).mockResolvedValue(makeRuntimeResult());
    vi.mocked(sessionRepo.update).mockImplementation(async (id) => makeSession(id));

    await service.run({
      agentId: "agent_1",
      intent: "x",
      workspace: WORKSPACE,
      priorSessionId: "sess_prev",
    });

    const ctx = vi.mocked(runtime.execute).mock.calls[0]![0];
    expect(ctx.resume_session_id).toBe("cli_prev_abc");
  });

  it("fires onTaskComplete with the new session id (fire-and-forget)", async () => {
    let createdId = "";
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.create).mockImplementation(async (i) => {
      createdId = i.id;
      return makeSession(i.id);
    });
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue({ systemPromptAppend: "", userMessagePrefix: "", snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] } });
    vi.mocked(runtime.execute).mockResolvedValue(makeRuntimeResult());
    vi.mocked(sessionRepo.update).mockImplementation(async (id) => makeSession(id));
    vi.mocked(memoryAgent.onTaskComplete).mockResolvedValue();

    await service.run({
      agentId: "agent_1",
      intent: "x",
      workspace: WORKSPACE,
    });
    // Yield to microtask queue so the void-awaited promotion fires
    await new Promise((r) => setTimeout(r, 0));
    expect(memoryAgent.onTaskComplete).toHaveBeenCalledWith(createdId);
  });

  it("throws when agent is not found", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(undefined);
    await expect(
      service.run({
        agentId: "agent_missing",
        intent: "x",
          workspace: WORKSPACE,
      }),
    ).rejects.toThrow(/agent not found/);
  });

  it("defaults type to 'chat' when no taskId and 'task' when taskId is set", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.create).mockImplementation(async (i) => makeSession(i.id));
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue({ systemPromptAppend: "", userMessagePrefix: "", snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] } });
    vi.mocked(runtime.execute).mockResolvedValue(makeRuntimeResult());
    vi.mocked(sessionRepo.update).mockImplementation(async (id) => makeSession(id));

    await service.run({
      agentId: "agent_1",
      intent: "x",
      workspace: WORKSPACE,
    });
    expect(vi.mocked(sessionRepo.create).mock.calls[0]![0].type).toBe("chat");

    vi.mocked(sessionRepo.create).mockClear();
    await service.run({
      agentId: "agent_1",
      intent: "y",
      workspace: WORKSPACE,
      taskId: "task_xyz",
    });
    expect(vi.mocked(sessionRepo.create).mock.calls[0]![0].type).toBe("task");
  });

  it("fires onSessionComplete with the terminal session row (fire-and-forget)", async () => {
    const onSessionComplete = vi.fn<NonNullable<AgentSessionDeps["onSessionComplete"]>>().mockResolvedValue();
    const svc = new AgentSession({
      agentRepo,
      sessionRepo,
      sessionEventRepo,
      runtime,
      memoryAgent,
      onSessionComplete,
    });
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.create).mockImplementation(async (i) => makeSession(i.id));
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue({ systemPromptAppend: "", userMessagePrefix: "", snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] } });
    vi.mocked(runtime.execute).mockResolvedValue(makeRuntimeResult());
    vi.mocked(sessionRepo.update).mockImplementation(async (id, patch) =>
      makeSession(id, patch as Partial<Session>),
    );

    await svc.run({ agentId: "agent_1", intent: "x", workspace: WORKSPACE });
    await new Promise((r) => setTimeout(r, 0));

    expect(onSessionComplete).toHaveBeenCalledTimes(1);
    expect(onSessionComplete.mock.calls[0]![0].status).toBe("succeeded");
  });

  it("skips onSessionComplete when input.skipOnComplete is true (used by post-dispatch retry)", async () => {
    const onSessionComplete = vi.fn<NonNullable<AgentSessionDeps["onSessionComplete"]>>().mockResolvedValue();
    const svc = new AgentSession({
      agentRepo,
      sessionRepo,
      sessionEventRepo,
      runtime,
      memoryAgent,
      onSessionComplete,
    });
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.create).mockImplementation(async (i) => makeSession(i.id));
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue({ systemPromptAppend: "", userMessagePrefix: "", snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] } });
    vi.mocked(runtime.execute).mockResolvedValue(makeRuntimeResult());
    vi.mocked(sessionRepo.update).mockImplementation(async (id) => makeSession(id));

    await svc.run({
      agentId: "agent_1",
      intent: "x",
      workspace: WORKSPACE,
      skipOnComplete: true,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(onSessionComplete).not.toHaveBeenCalled();
  });

  it("hook errors are caught and logged, never propagated to the caller", async () => {
    const onSessionComplete = vi
      .fn<NonNullable<AgentSessionDeps["onSessionComplete"]>>()
      .mockRejectedValue(new Error("hook blew up"));
    const svc = new AgentSession({
      agentRepo,
      sessionRepo,
      sessionEventRepo,
      runtime,
      memoryAgent,
      onSessionComplete,
    });
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.create).mockImplementation(async (i) => makeSession(i.id));
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue({ systemPromptAppend: "", userMessagePrefix: "", snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] } });
    vi.mocked(runtime.execute).mockResolvedValue(makeRuntimeResult());
    vi.mocked(sessionRepo.update).mockImplementation(async (id) => makeSession(id));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      svc.run({ agentId: "agent_1", intent: "x", workspace: WORKSPACE }),
    ).resolves.toBeDefined();
    await new Promise((r) => setTimeout(r, 0));

    expect(errSpy).toHaveBeenCalledWith(
      "[AgentSession] onSessionComplete failed:",
      "hook blew up",
    );
    errSpy.mockRestore();
  });
});

// ── buildIntent helper (M6.3, wired to dispatch in M6.5) ──────────────────

const INTENT_TASK: IntentTask = {
  id: "task_xyz",
  title: "Add error handling",
  description: "Wrap the auth path with retry logic.",
};

describe("buildIntent", () => {
  it("fresh: full task body in <task id> envelope", () => {
    const out = buildIntent(INTENT_TASK, { kind: "fresh" });
    expect(out).toContain('<task id="task_xyz">');
    expect(out).toContain("Add error handling");
    expect(out).toContain("Wrap the auth path with retry logic.");
    expect(out).not.toContain("<context");
  });

  it("fresh with no description: just title in envelope", () => {
    const t: IntentTask = { id: "t1", title: "Do thing" };
    const out = buildIntent(t, { kind: "fresh" });
    expect(out).toBe('<task id="t1">\nDo thing\n</task>');
  });

  it("crash_recovery: self-closing <task id/> + crash_recovery context", () => {
    const out = buildIntent(INTENT_TASK, { kind: "crash_recovery" });
    expect(out).toContain('<task id="task_xyz"/>');
    expect(out).not.toContain('<task id="task_xyz">\n');
    expect(out).toContain('<context type="crash_recovery">');
    expect(out).toContain("Pick up where you left off");
    expect(out).not.toContain("Add error handling");
  });

  it("revision (parent_agent + blocked): post-blocker preamble", () => {
    const reason: ResumeReason = {
      kind: "revision",
      feedback: "Use the existing connection pool, don't open a new one.",
      source: "parent_agent",
      from_status: "blocked",
    };
    const out = buildIntent(INTENT_TASK, reason);
    expect(out).toContain('<context type="revision" source="parent_agent" from="blocked">');
    expect(out).toContain("Your parent agent has resolved the blocker you reported");
    expect(out).toContain("Use the existing connection pool");
    expect(out).toContain('<task id="task_xyz"/>');
  });

  it("revision (human + review): review-cycle preamble", () => {
    const reason: ResumeReason = {
      kind: "revision",
      feedback: "Please add unit tests for the edge cases.",
      source: "human",
      from_status: "review",
    };
    const out = buildIntent(INTENT_TASK, reason);
    expect(out).toContain('source="human" from="review"');
    expect(out).toContain("A human reviewer requested changes");
    expect(out).toContain("Please add unit tests for the edge cases.");
  });

  it("revision with empty feedback uses placeholder", () => {
    const reason: ResumeReason = {
      kind: "revision",
      feedback: "",
      source: "human",
      from_status: "review",
    };
    const out = buildIntent(INTENT_TASK, reason);
    expect(out).toContain("(no specific feedback provided)");
  });

  it("post_escalation initiator: continues task with resolution", () => {
    const reason: ResumeReason = {
      kind: "post_escalation",
      role: "initiator",
      resolution: {
        title: "Hybrid approach",
        description: "Reuse component X but rewrite Y.",
        source: "human",
      },
      notes: "Cap timeline at 4 weeks.",
    };
    const out = buildIntent(INTENT_TASK, reason);
    expect(out).toContain('<context type="post_escalation" role="initiator">');
    expect(out).toContain("Hybrid approach — Reuse component X but rewrite Y.");
    expect(out).toContain("Additional guidance: Cap timeline at 4 weeks.");
    expect(out).toContain("Continue your task using this resolution.");
  });

  it("post_escalation counterparty: memory-update + exit framing", () => {
    const reason: ResumeReason = {
      kind: "post_escalation",
      role: "counterparty",
      resolution: {
        title: "Approach A",
        description: "...",
        source: "initiator",
        source_index: 0,
      },
    };
    const out = buildIntent(INTENT_TASK, reason);
    expect(out).toContain('role="counterparty"');
    expect(out).toContain("Update your memory with anything notable");
    expect(out).toContain("complete any related follow-up, then exit.");
    expect(out).toContain("Approach A");
  });

  it("post_escalation without notes omits the Additional guidance line", () => {
    const reason: ResumeReason = {
      kind: "post_escalation",
      role: "initiator",
      resolution: { title: "A", description: "b", source: "human" },
    };
    const out = buildIntent(INTENT_TASK, reason);
    expect(out).not.toContain("Additional guidance:");
  });

  it("null task: omits the <task> anchor entirely (e.g., user-driven chat)", () => {
    const out = buildIntent(null, { kind: "crash_recovery" });
    expect(out).toContain('<context type="crash_recovery">');
    expect(out).not.toContain("<task");
  });
});
