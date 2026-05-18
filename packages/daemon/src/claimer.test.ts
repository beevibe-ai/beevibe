import { describe, expect, it, vi } from "vitest";
import type { LocalWorkspaceManager } from "@beevibe/core/adapters/local-workspace";
import type WebSocket from "ws";
import type { ApiClient } from "./api-client.js";
import { Claimer } from "./claimer.js";
import { Supervisor } from "./supervisor.js";

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  // Minimal stub — Claimer only uses claim/post/openWebSocket.
  return {
    claim: vi.fn(async () => undefined),
    post: vi.fn(async () => ({ status: 204, body: undefined })),
    openWebSocket: vi.fn(() => fakeWs()),
    ...overrides,
  } as unknown as ApiClient;
}

function fakeWs(): WebSocket {
  // Bare event-emitter shape — Claimer only attaches listeners + calls close.
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const ws = {
    on(event: string, cb: (...args: unknown[]) => void) {
      const arr = handlers.get(event) ?? [];
      arr.push(cb);
      handlers.set(event, arr);
      return ws;
    },
    removeAllListeners() {
      handlers.clear();
    },
    close() {},
  };
  return ws as unknown as WebSocket;
}

describe("Claimer.pollRuntime resilience", () => {
  it("swallows ECONNREFUSED from claim() without bubbling — daemon survives", async () => {
    const claim = vi.fn(async () => {
      // Mirror the actual shape of a Node 20+ fetch failure.
      throw new TypeError("fetch failed");
    });
    const api = makeApi({ claim } as Partial<ApiClient>);
    const claimer = new Claimer({
      api,
      supervisor: new Supervisor(2),
      workspaceManager: {} as LocalWorkspaceManager,
      runtimeRegistry: {},
      runtimeIds: ["rt_1"],
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    });

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      claimer.start();
      // Yield twice — once for the initial pollAll, once for any deferred reject.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(claim).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      await claimer.stop();
    }
  });
});
