import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";

const apiState: { isApiConfigured: boolean; apiBaseUrl: string | null } = {
  isApiConfigured: true,
  apiBaseUrl: "https://api.example.com",
};

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
  get apiBaseUrl() {
    return apiState.apiBaseUrl;
  },
}));

import { useLiveUpdates } from "./sse";
import { queryKeys } from "./hooks/keys";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) } as MessageEvent);
  }

  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  apiState.isApiConfigured = true;
  apiState.apiBaseUrl = "https://api.example.com";
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeWrapper(client: QueryClient) {
  return function TestQueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useLiveUpdates", () => {
  it("does not open an EventSource when API is not configured", () => {
    apiState.isApiConfigured = false;
    apiState.apiBaseUrl = null;
    const client = new QueryClient();
    renderHook(() => useLiveUpdates(), { wrapper: makeWrapper(client) });
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("opens an EventSource on /api/stream with credentials when configured", () => {
    const client = new QueryClient();
    renderHook(() => useLiveUpdates(), { wrapper: makeWrapper(client) });
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe("https://api.example.com/api/stream");
    expect(MockEventSource.instances[0].withCredentials).toBe(true);
  });

  it("closes the EventSource on unmount", () => {
    const client = new QueryClient();
    const { unmount } = renderHook(() => useLiveUpdates(), { wrapper: makeWrapper(client) });
    const source = MockEventSource.instances[0];
    expect(source.closed).toBe(false);
    unmount();
    expect(source.closed).toBe(true);
  });

  it("invalidates the right query keys on a known event", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useLiveUpdates(), { wrapper: makeWrapper(client) });
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit({ event: "task.updated", task_id: "t1" });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.tasks.all });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.dashboard.all });
  });

  it("ignores events without an event field and malformed JSON", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useLiveUpdates(), { wrapper: makeWrapper(client) });
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit({ no_event_field: true });
      source.emit("not-json-at-all");
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("ignores unknown event names without throwing", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useLiveUpdates(), { wrapper: makeWrapper(client) });
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit({ event: "completely.unknown" });
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("dispatches mesh + memory + promotion + thread invalidations on their events", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useLiveUpdates(), { wrapper: makeWrapper(client) });
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit({ event: "mesh.activity" });
      source.emit({ event: "memory.fact.created" });
      source.emit({ event: "promotion.created" });
      source.emit({ event: "thread.message" });
      source.emit({ event: "session.updated" });
      source.emit({ event: "agent.updated" });
    });

    const invocations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invocations).toEqual(
      expect.arrayContaining([
        queryKeys.mesh.all,
        queryKeys.memory.all,
        queryKeys.promotions.all,
        queryKeys.threads.all,
        queryKeys.sessions.all,
        queryKeys.agents.all,
      ]),
    );
  });
});
