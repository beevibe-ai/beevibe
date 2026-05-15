/**
 * MeshServer unit tests. Focused on the failure-propagation path —
 * when a callee session terminates non-success, the caller's pending
 * `ask`/`negotiate` promise must reject within a tick instead of sitting
 * through the 5-minute resolver timeout (which surfaces to the MCP layer
 * as a generic "transport dropped" error).
 */

import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  NegotiationRepository,
  NegotiationRoundRepository,
  RuntimeRegistry,
  SessionEventRepository,
  SessionRepository,
  WorkspaceManager,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { MeshServer } from "./server.js";

function makeMesh() {
  const dispatchCalls: Array<{ agentId: string; sessionIdOverride?: string }> = [];
  const dispatchService = {
    dispatchTask: vi.fn(async (opts: { agentId: string; sessionIdOverride?: string }) => {
      dispatchCalls.push(opts);
      // Return a minimal shape that satisfies the type — MeshServer
      // discards the return via `void`, so values don't matter.
      return {} as Awaited<ReturnType<DispatchService["dispatchTask"]>>;
    }),
  } as unknown as DispatchService;

  const mesh = new MeshServer({
    agentRepo: {
      findById: vi.fn(async (id: string) => ({
        id,
        name: id,
        owner_id: "per_1",
        hierarchy_level: "team" as const,
        max_mesh_sessions: 5,
        max_negotiation_rounds: 5,
        runtime_config: { type: "claude" as const },
      })),
    } as unknown as AgentRepository,
    sessionRepo: {
      countRunningByAgent: vi.fn(async () => 0),
    } as unknown as SessionRepository,
    sessionEventRepo: {} as SessionEventRepository,
    negotiationRepo: {} as NegotiationRepository,
    negotiationRoundRepo: {} as NegotiationRoundRepository,
    workspaceManager: {} as WorkspaceManager,
    runtimeRegistry: {} as RuntimeRegistry,
    dispatchService,
    makeMemoryAgent: () => ({}) as never,
  });

  return { mesh, dispatchCalls };
}

describe("MeshServer.failResolverForCalleeSession", () => {
  it("rejects an ask waiter as soon as the callee session is marked failed", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const ask = mesh.sendAsk("req_1", "agent_caller", "agent_callee", "hello?");

    // sendAsk awaits capacity checks before kicking off the spawn — wait
    // a full event-loop tick so the pre-minted sessionId reaches the spy.
    await new Promise((r) => setImmediate(r));
    const calleeSid = dispatchCalls[0]?.sessionIdOverride;
    expect(calleeSid).toBeDefined();

    mesh.failResolverForCalleeSession(calleeSid!, "process_lost");

    await expect(ask).rejects.toThrow(/mesh callee session failed: process_lost/);
  });

  it("is a no-op when the callee session has no pending waiter", () => {
    const { mesh } = makeMesh();
    // Should not throw; no resolver is registered for this id.
    expect(() => mesh.failResolverForCalleeSession("sess_unknown", "x")).not.toThrow();
  });

  it("hasPendingCalleeSession tracks the in-flight reverse index", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    expect(mesh.hasPendingCalleeSession("sess_unknown")).toBe(false);

    const ask = mesh.sendAsk("req_3", "agent_caller", "agent_callee", "yo?");
    await new Promise((r) => setImmediate(r));
    const calleeSid = dispatchCalls[0]?.sessionIdOverride;
    expect(calleeSid).toBeDefined();
    expect(mesh.hasPendingCalleeSession(calleeSid!)).toBe(true);

    // Drains on fast-fail.
    mesh.failResolverForCalleeSession(calleeSid!, "x");
    await expect(ask).rejects.toThrow();
    expect(mesh.hasPendingCalleeSession(calleeSid!)).toBe(false);
  });

  it("does not interfere with the success path", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const ask = mesh.sendAsk("req_2", "agent_caller", "agent_callee", "ping?");

    await new Promise((r) => setImmediate(r));
    const calleeSid = dispatchCalls[0]?.sessionIdOverride;
    expect(calleeSid).toBeDefined();

    mesh.respondAsk("req_2", {
      request_id: "req_2",
      from_agent_id: "agent_callee",
      answer: "pong",
    });

    await expect(ask).resolves.toEqual({
      request_id: "req_2",
      from_agent_id: "agent_callee",
      answer: "pong",
    });

    // After the success path drains the reverse index, a stale failure
    // signal for the same session is a no-op (idempotency).
    expect(() => mesh.failResolverForCalleeSession(calleeSid!, "late")).not.toThrow();
  });
});
