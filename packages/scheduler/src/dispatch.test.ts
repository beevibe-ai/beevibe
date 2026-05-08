/**
 * Phase 4 dispatcher tests. The dispatcher takes an already-claimed
 * session row (status='running', set by claimNextForServerFallback) and
 * runs AgentSession with it. The intent + prior_session_id were already
 * composed by dispatchService at session-creation time, so dispatch.ts
 * is now a thin pass-through to AgentSession.run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  AgentRuntime,
  RuntimeRegistry,
  Session,
  SessionEventRepository,
  SessionRepository,
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
    runtime_config: { type: "claude" },
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_test",
    agent_id: "agent_test",
    type: "task",
    status: "running",
    intent: "<task id=\"task_test\">Do a thing</task>",
    created_at: new Date(),
    ...overrides,
  };
}

const WORKSPACE: Workspace = { path: "/tmp/ws" };
const SIGNAL = new AbortController().signal;

let agentRepo: AgentRepository;
let sessionRepo: SessionRepository;
let sessionEventRepo: SessionEventRepository;
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
    claimNextForRuntime: vi.fn(),
    claimNextForServerFallback: vi.fn(),
    countOwnedByDaemon: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  sessionEventRepo = {
    append: vi.fn().mockResolvedValue(undefined),
    listBySession: vi.fn(),
  } as unknown as SessionEventRepository;
  fakeRuntime = {
    type: "claude",
    execute: vi.fn(),
    healthCheck: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as AgentRuntime;

  // Spy on AgentSession.run — dispatcher should call it once per session
  // with the claimed-session id flowing through. No need to actually
  // execute anything; we assert the inputs.
  runSpy = vi.spyOn(AgentSession.prototype, "run").mockImplementation(
    async function (this: AgentSession, input) {
      return makeSession({
        id: input.sessionId ?? "sess_test",
        agent_id: input.agentId,
      });
    } as unknown as AgentSession["run"],
  );
});

const runtimeRegistry: RuntimeRegistry = {
  get claude() {
    return fakeRuntime;
  },
} as unknown as RuntimeRegistry;

const memoryAgent = {
  prepareBriefing: vi.fn(),
  onTaskComplete: vi.fn(),
} as unknown as MemoryAgent;

function makeDispatcher() {
  return createTaskDispatcher({
    agentRepo,
    sessionRepo,
    sessionEventRepo,
    runtimeRegistry,
    makeMemoryAgent: () => memoryAgent,
  });
}

describe("createTaskDispatcher (Phase 4)", () => {
  it("threads the claimed session through to AgentSession.run with no re-derivation", async () => {
    const dispatcher = makeDispatcher();
    const session = makeSession({
      id: "sess_42",
      task_id: "task_42",
      intent: "composed by dispatchService earlier",
      prior_session_id: "sess_prior",
      type: "task",
    });
    await dispatcher(session, makeAgent({ id: "agent_42" }), WORKSPACE, SIGNAL);

    expect(runSpy).toHaveBeenCalledOnce();
    const arg = runSpy.mock.calls[0]![0] as Parameters<AgentSession["run"]>[0];
    expect(arg.sessionId).toBe("sess_42");
    expect(arg.agentId).toBe("agent_42");
    expect(arg.taskId).toBe("task_42");
    expect(arg.intent).toBe("composed by dispatchService earlier");
    expect(arg.priorSessionId).toBe("sess_prior");
    expect(arg.type).toBe("task");
    expect(arg.workspace).toBe(WORKSPACE);
    expect(arg.abortSignal).toBe(SIGNAL);
  });

  it("propagates session.type so chat / mesh sessions don't run as 'task'", async () => {
    const dispatcher = makeDispatcher();
    const session = makeSession({ id: "sess_chat", type: "chat", task_id: undefined });
    await dispatcher(session, makeAgent(), WORKSPACE, SIGNAL);
    const arg = runSpy.mock.calls[0]![0] as Parameters<AgentSession["run"]>[0];
    expect(arg.type).toBe("chat");
    expect(arg.taskId).toBeUndefined();
  });

  it("rejects when the agent's runtime type is not registered", async () => {
    const dispatcher = makeDispatcher();
    const session = makeSession();
    const exoticAgent = makeAgent({ runtime_config: { type: "exotic" as never } });
    await expect(dispatcher(session, exoticAgent, WORKSPACE, SIGNAL)).rejects.toThrow(
      /Unsupported runtime/,
    );
    expect(runSpy).not.toHaveBeenCalled();
  });
});
