import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";

const apiState: { isApiConfigured: boolean; apiBaseUrl: string | null; userKey: string | null } = {
  isApiConfigured: true,
  apiBaseUrl: "https://api.example.com",
  userKey: "bv_u_test",
};

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
  get apiBaseUrl() {
    return apiState.apiBaseUrl;
  },
  getUserKey: () => apiState.userKey,
  subscribeToUserKey: (_cb: () => void) => () => {},
}));

import { useLiveUpdates, useSseEvents, __resetSseStateForTests } from "./sse";
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
    this.onmessage?.({
      data: typeof data === "string" ? data : JSON.stringify(data),
    } as MessageEvent);
  }

  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  __resetSseStateForTests();
  MockEventSource.instances = [];
  apiState.isApiConfigured = true;
  apiState.apiBaseUrl = "https://api.example.com";
  apiState.userKey = "bv_u_test";
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  __resetSseStateForTests();
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

  it("does not open an EventSource when no user key is available", () => {
    apiState.userKey = null;
    const client = new QueryClient();
    renderHook(() => useLiveUpdates(), { wrapper: makeWrapper(client) });
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("opens an EventSource on /api/stream with token query + credentials", () => {
    const client = new QueryClient();
    renderHook(() => useLiveUpdates(), { wrapper: makeWrapper(client) });
    expect(MockEventSource.instances).toHaveLength(1);
    const url = new URL(MockEventSource.instances[0].url);
    expect(url.origin + url.pathname).toBe("https://api.example.com/api/stream");
    expect(url.searchParams.get("token")).toBe("bv_u_test");
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
      source.emit({ event: "task.updated", id: "t1" });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.tasks.all });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.dashboard.all });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activity.all });
  });

  it("ignores events without an event field, missing id, and malformed JSON", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useLiveUpdates(), { wrapper: makeWrapper(client) });
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit({ no_event_field: true });
      source.emit({ event: "task.updated" }); // missing id
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
      source.emit({ event: "completely.unknown", id: "x1" });
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("dispatches mesh + memory + promotion + session + agent invalidations", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useLiveUpdates(), { wrapper: makeWrapper(client) });
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit({ event: "mesh.activity", id: "m1" });
      source.emit({ event: "memory.fact.created", id: "f1" });
      source.emit({ event: "promotion.created", id: "p1" });
      source.emit({ event: "session.updated", id: "s1" });
      source.emit({ event: "agent.updated", id: "a1" });
      source.emit({ event: "runtime.updated", id: "r1" });
    });

    const invocations = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invocations).toEqual(
      expect.arrayContaining([
        queryKeys.mesh.all,
        queryKeys.memory.all,
        queryKeys.promotions.all,
        queryKeys.sessions.all,
        queryKeys.agents.all,
        queryKeys.runtimes.all,
      ]),
    );
  });

  it("session.updated invalidates chat.all (multi-tab consistency)", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useLiveUpdates(), { wrapper: makeWrapper(client) });
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit({ event: "session.updated", id: "s1" });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.chat.all });
  });
});

describe("useSseEvents", () => {
  it("delivers raw events to subscribers, not just invalidations", () => {
    const client = new QueryClient();
    const seen: { event: string; id: string }[] = [];
    renderHook(() => useSseEvents((e) => seen.push({ event: e.event, id: e.id })), {
      wrapper: makeWrapper(client),
    });
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit({ event: "session.step", id: "evt_1", data: { kind: "agent" } });
      source.emit({ event: "task.updated", id: "t1" });
    });

    expect(seen).toEqual([
      { event: "session.step", id: "evt_1" },
      { event: "task.updated", id: "t1" },
    ]);
  });

  it("shares one EventSource across multiple subscribers", () => {
    const client = new QueryClient();
    renderHook(() => useSseEvents(() => {}), { wrapper: makeWrapper(client) });
    renderHook(() => useSseEvents(() => {}), { wrapper: makeWrapper(client) });
    expect(MockEventSource.instances).toHaveLength(1);
  });
});
