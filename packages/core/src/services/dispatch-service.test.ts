import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../domain/agent.js";
import type { Session } from "../domain/session.js";
import type { Task } from "../domain/task.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { SessionRepository } from "../ports/session-repo.js";
import { DispatchService } from "./dispatch-service.js";
import type { ResumeReason } from "./agent-session.js";

const FIXED_NOW = new Date("2026-05-08T00:00:00Z");

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_default",
    name: "Default",
    owner_id: "person_owner",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_default",
    agent_id: "agent_default",
    type: "task",
    status: "pending",
    intent: "do stuff",
    created_at: FIXED_NOW,
    ...overrides,
  };
}

let agentRepo: AgentRepository;
let sessionRepo: SessionRepository;
let onSessionInserted: ReturnType<typeof vi.fn>;
let svc: DispatchService;

beforeEach(() => {
  agentRepo = {
    findById: vi.fn(),
    findByApiKey: vi.fn(),
    findByOwnerId: vi.fn(),
    findTopLevelForOwner: vi.fn(),
    findSubordinates: vi.fn(),
    findPeers: vi.fn(),
    findParent: vi.fn(),
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
    create: vi.fn().mockImplementation(async (input) =>
      makeSession({ id: input.id, agent_id: input.agent_id, ...input }),
    ),
    update: vi.fn(),
  };
  onSessionInserted = vi.fn().mockResolvedValue(undefined);
  svc = new DispatchService({ agentRepo, sessionRepo, onSessionInserted });
});

describe("DispatchService.dispatchTask", () => {
  it("inserts a pending session with status='pending', spawn_mode='daemon'", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    const reason: ResumeReason = { kind: "fresh" };

    await svc.dispatchTask({
      agentId: "agent_default",
      intent: "hello",
      reason,
      type: "task",
    });

    expect(sessionRepo.create).toHaveBeenCalledOnce();
    const insert = vi.mocked(sessionRepo.create).mock.calls[0]![0];
    expect(insert.status).toBe("pending");
    expect(insert.spawn_mode).toBe("daemon");
    expect(insert.type).toBe("task");
    expect(insert.intent).toBe("hello");
    expect(insert.runtime_id).toBeUndefined();
    expect(insert.prior_session_id).toBeUndefined();
  });

  it("fresh reason resolves runtime_id from agent.preferred_runtime_id", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(
      makeAgent({ preferred_runtime_id: "rt_default" }),
    );
    const reason: ResumeReason = { kind: "fresh" };

    const result = await svc.dispatchTask({
      agentId: "agent_default",
      intent: "x",
      reason,
      type: "task",
    });

    expect(result.runtime_id).toBe("rt_default");
    const insert = vi.mocked(sessionRepo.create).mock.calls[0]![0];
    expect(insert.runtime_id).toBe("rt_default");
  });

  it("crash_recovery reason falls back to agent.preferred_runtime_id (no prior pin)", async () => {
    // crash_recovery is inferred from session-row state, not next_dispatch_context;
    // ResumeReason for crash_recovery doesn't carry a prior_session_id.
    vi.mocked(agentRepo.findById).mockResolvedValue(
      makeAgent({ preferred_runtime_id: "rt_default" }),
    );
    const reason: ResumeReason = { kind: "crash_recovery" };

    const result = await svc.dispatchTask({
      agentId: "agent_default",
      intent: "x",
      reason,
      type: "task",
    });

    expect(result.runtime_id).toBe("rt_default");
    expect(sessionRepo.findById).not.toHaveBeenCalled();
  });

  it("revision reason PINS runtime_id to prior_session.runtime_id", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(
      makeAgent({ preferred_runtime_id: "rt_new_default" }),
    );
    vi.mocked(sessionRepo.findById).mockResolvedValue(
      makeSession({ id: "sess_prior", runtime_id: "rt_pinned" }),
    );
    const reason: ResumeReason = {
      kind: "revision",
      feedback: "fix it",
      source: "human",
      from_status: "review",
      prior_session_id: "sess_prior",
    };

    const result = await svc.dispatchTask({
      agentId: "agent_default",
      intent: "x",
      reason,
      type: "task",
    });

    expect(result.runtime_id).toBe("rt_pinned");
    const insert = vi.mocked(sessionRepo.create).mock.calls[0]![0];
    expect(insert.runtime_id).toBe("rt_pinned");
    expect(insert.prior_session_id).toBe("sess_prior");
  });

  it("post_escalation reason PINS runtime_id to prior_session.runtime_id", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.findById).mockResolvedValue(
      makeSession({ id: "sess_neg", runtime_id: "rt_neg" }),
    );
    const reason: ResumeReason = {
      kind: "post_escalation",
      role: "initiator",
      resolution: { title: "T", description: "D", proposals: [], notes: "" },
      prior_session_id: "sess_neg",
    };

    const result = await svc.dispatchTask({
      agentId: "agent_default",
      intent: "x",
      reason,
      type: "task",
    });

    expect(result.runtime_id).toBe("rt_neg");
    const insert = vi.mocked(sessionRepo.create).mock.calls[0]![0];
    expect(insert.prior_session_id).toBe("sess_neg");
  });

  it("falls back to agent.preferred_runtime_id when prior session has null runtime_id", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(
      makeAgent({ preferred_runtime_id: "rt_default" }),
    );
    vi.mocked(sessionRepo.findById).mockResolvedValue(
      makeSession({ id: "sess_legacy" /* runtime_id: undefined */ }),
    );
    const reason: ResumeReason = {
      kind: "revision",
      feedback: "fix it",
      source: "human",
      from_status: "review",
      prior_session_id: "sess_legacy",
    };

    const result = await svc.dispatchTask({
      agentId: "agent_default",
      intent: "x",
      reason,
      type: "task",
    });

    expect(result.runtime_id).toBe("rt_default");
  });

  it("runtimeIdOverride wins over both prior pinning and agent default", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(
      makeAgent({ preferred_runtime_id: "rt_default" }),
    );
    const reason: ResumeReason = { kind: "fresh" };

    await svc.dispatchTask({
      agentId: "agent_default",
      intent: "x",
      reason,
      type: "task",
      runtimeIdOverride: "rt_override",
    });

    const insert = vi.mocked(sessionRepo.create).mock.calls[0]![0];
    expect(insert.runtime_id).toBe("rt_override");
  });

  it("fires onSessionInserted with the freshly-inserted session row", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    const reason: ResumeReason = { kind: "fresh" };

    const result = await svc.dispatchTask({
      agentId: "agent_default",
      intent: "x",
      reason,
      type: "task",
    });

    expect(onSessionInserted).toHaveBeenCalledOnce();
    expect(onSessionInserted.mock.calls[0]![0]).toBe(result.session);
  });

  it("swallows onSessionInserted errors so dispatch never fails on a flaky wakeup", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    onSessionInserted.mockRejectedValue(new Error("hub down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reason: ResumeReason = { kind: "fresh" };

    await expect(
      svc.dispatchTask({
        agentId: "agent_default",
        intent: "x",
        reason,
        type: "task",
      }),
    ).resolves.toBeDefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("throws when agent does not exist", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(undefined);
    const reason: ResumeReason = { kind: "fresh" };

    await expect(
      svc.dispatchTask({
        agentId: "agent_missing",
        intent: "x",
        reason,
        type: "task",
      }),
    ).rejects.toThrow(/not found/);
    expect(sessionRepo.create).not.toHaveBeenCalled();
  });
});
