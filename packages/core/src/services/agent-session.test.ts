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
import { AgentSession } from "./agent-session.js";
import type { MemoryAgent } from "./memory/memory-agent.js";

const WORKSPACE: Workspace = { path: "/tmp/ws" };

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_1",
    name: "A",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude-code", model: "claude-opus-4-7" },
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
  runtime = {
    type: "fake",
    execute: vi.fn(),
    healthCheck: vi.fn(),
    shutdown: vi.fn(),
  };
  memoryAgent = {
    prepareBriefing: vi.fn(),
    // Default to a resolved promise so the fire-and-forget .catch() has something to chain.
    onTaskComplete: vi.fn<MemoryAgent["onTaskComplete"]>().mockResolvedValue(),
  };
  service = new AgentSession({ agentRepo, sessionRepo, runtime, memoryAgent });
});

describe("AgentSession.run", () => {
  it("threads briefing + baseline into system_prompt_append and marks session succeeded", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(
      makeAgent({
        runtime_config: {
          type: "claude-code",
          model: "claude-opus-4-7",
          system_prompt_addition: "Follow the house style.",
        },
      }),
    );
    vi.mocked(sessionRepo.create).mockImplementation(async (input) =>
      makeSession(input.id),
    );
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue(
      "<core_memory></core_memory><archival_memory></archival_memory>",
    );
    vi.mocked(runtime.execute).mockResolvedValue(makeRuntimeResult());
    vi.mocked(sessionRepo.update).mockImplementation(async (id, patch) =>
      makeSession(id, patch as Partial<Session>),
    );

    const out = await service.run({
      agentId: "agent_1",
      intent: "Reply with 'ok'.",
      urgency: "normal",
      workspace: WORKSPACE,
      taskId: "task_1",
    });

    expect(memoryAgent.prepareBriefing).toHaveBeenCalledWith("Reply with 'ok'.");
    const ctx = vi.mocked(runtime.execute).mock.calls[0]![0];
    expect(ctx.system_prompt_append).toBe(
      "Follow the house style.\n\n<core_memory></core_memory><archival_memory></archival_memory>",
    );
    expect(ctx.workspace).toBe(WORKSPACE);
    expect(ctx.intent).toBe("Reply with 'ok'.");

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
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue("");
    vi.mocked(runtime.execute).mockImplementation(async (ctx) => {
      // session should already exist by now — prove it by asserting the onSpawn update lands
      ctx.onSpawn?.({ process_pid: 99, process_group_id: 99 });
      return makeRuntimeResult();
    });
    vi.mocked(sessionRepo.update).mockImplementation(async (id) => makeSession(id));

    await service.run({
      agentId: "agent_1",
      intent: "x",
      urgency: "normal",
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
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue("");
    vi.mocked(runtime.execute).mockResolvedValue(
      makeRuntimeResult({ status: "cancelled", output: "Session cancelled." }),
    );
    vi.mocked(sessionRepo.update).mockImplementation(async (id, patch) =>
      makeSession(id, patch as Partial<Session>),
    );

    const out = await service.run({
      agentId: "agent_1",
      intent: "x",
      urgency: "normal",
      workspace: WORKSPACE,
    });
    expect(out.status).toBe("cancelled");
  });

  it("sets session to 'failed' and rethrows when runtime throws", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.create).mockImplementation(async (i) => makeSession(i.id));
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue("");
    vi.mocked(runtime.execute).mockRejectedValue(new Error("spawn ENOENT"));
    vi.mocked(sessionRepo.update).mockImplementation(async (id, patch) =>
      makeSession(id, patch as Partial<Session>),
    );

    await expect(
      service.run({
        agentId: "agent_1",
        intent: "x",
        urgency: "normal",
        workspace: WORKSPACE,
      }),
    ).rejects.toThrow(/spawn ENOENT/);

    const failPatch = vi
      .mocked(sessionRepo.update)
      .mock.calls.find((c) => (c[1] as { status?: string }).status === "failed");
    expect(failPatch).toBeDefined();
    expect(failPatch![1].error).toContain("spawn ENOENT");
  });

  it("resolves --resume via priorSessionId's cli_session_id", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.findById).mockResolvedValue(
      makeSession("sess_prev", { cli_session_id: "cli_prev_abc" }),
    );
    vi.mocked(sessionRepo.create).mockImplementation(async (i) => makeSession(i.id));
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue("");
    vi.mocked(runtime.execute).mockResolvedValue(makeRuntimeResult());
    vi.mocked(sessionRepo.update).mockImplementation(async (id) => makeSession(id));

    await service.run({
      agentId: "agent_1",
      intent: "x",
      urgency: "normal",
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
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue("");
    vi.mocked(runtime.execute).mockResolvedValue(makeRuntimeResult());
    vi.mocked(sessionRepo.update).mockImplementation(async (id) => makeSession(id));
    vi.mocked(memoryAgent.onTaskComplete).mockResolvedValue();

    await service.run({
      agentId: "agent_1",
      intent: "x",
      urgency: "normal",
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
        urgency: "normal",
        workspace: WORKSPACE,
      }),
    ).rejects.toThrow(/agent not found/);
  });

  it("defaults type to 'chat' when no taskId and 'task' when taskId is set", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent());
    vi.mocked(sessionRepo.create).mockImplementation(async (i) => makeSession(i.id));
    vi.mocked(memoryAgent.prepareBriefing).mockResolvedValue("");
    vi.mocked(runtime.execute).mockResolvedValue(makeRuntimeResult());
    vi.mocked(sessionRepo.update).mockImplementation(async (id) => makeSession(id));

    await service.run({
      agentId: "agent_1",
      intent: "x",
      urgency: "normal",
      workspace: WORKSPACE,
    });
    expect(vi.mocked(sessionRepo.create).mock.calls[0]![0].type).toBe("chat");

    vi.mocked(sessionRepo.create).mockClear();
    await service.run({
      agentId: "agent_1",
      intent: "y",
      urgency: "normal",
      workspace: WORKSPACE,
      taskId: "task_xyz",
    });
    expect(vi.mocked(sessionRepo.create).mock.calls[0]![0].type).toBe("task");
  });
});
