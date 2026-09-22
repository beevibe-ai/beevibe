import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
  apiBaseUrl: "https://api.example.com",
}));

import { useApiDetailQuery, useApiQuery } from "./api-query";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function TestQueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const KEYS = {
  all: ["thing"] as const,
  detail: (id: string) => ["thing", "detail", id] as const,
};

beforeEach(() => {
  apiState.isApiConfigured = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useApiQuery", () => {
  it("fetches once the API is configured", async () => {
    const fetch = vi.fn().mockResolvedValue("payload");
    const { result } = renderHook(() => useApiQuery(["k"], fetch), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe("payload");
  });

  it("does not fetch when the API is not configured", () => {
    apiState.isApiConfigured = false;
    const fetch = vi.fn().mockResolvedValue("payload");

    const { result } = renderHook(() => useApiQuery(["k"], fetch), { wrapper: wrapper() });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it("ANDs a caller's `enabled` with the config gate rather than replacing it", () => {
    // The whole point of the helper: a call site can add a precondition
    // but can't drop the one that keeps an unconfigured build from
    // throwing in `api/http.ts`.
    apiState.isApiConfigured = false;
    const fetch = vi.fn().mockResolvedValue("payload");

    renderHook(() => useApiQuery(["k"], fetch, { enabled: true }), { wrapper: wrapper() });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("honours a falsy caller `enabled` while configured", () => {
    const fetch = vi.fn().mockResolvedValue("payload");

    renderHook(() => useApiQuery(["k"], fetch, { enabled: false }), { wrapper: wrapper() });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes `select` through, narrowing the result type", async () => {
    const fetch = vi.fn().mockResolvedValue({ n: 2 });
    const { result } = renderHook(
      () => useApiQuery(["k"], fetch, { select: (v: { n: number }) => v.n * 21 }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(42);
  });

  it("surfaces a rejection as the query error", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useApiQuery(["k"], fetch), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("boom"));
  });
});

describe("useApiDetailQuery", () => {
  it("fetches with the id and the abort signal", async () => {
    const fetch = vi.fn().mockResolvedValue("row");
    const { result } = renderHook(() => useApiDetailQuery("t1", KEYS, fetch), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetch).toHaveBeenCalledWith("t1", expect.objectContaining({ signal: expect.anything() }));
  });

  it("is disabled while the id is undefined", () => {
    const fetch = vi.fn().mockResolvedValue("row");
    const { result } = renderHook(() => useApiDetailQuery(undefined, KEYS, fetch), {
      wrapper: wrapper(),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("treats an empty-string id as absent", () => {
    const fetch = vi.fn().mockResolvedValue("row");
    renderHook(() => useApiDetailQuery("", KEYS, fetch), { wrapper: wrapper() });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is disabled when the API is not configured even with an id", () => {
    apiState.isApiConfigured = false;
    const fetch = vi.fn().mockResolvedValue("row");

    renderHook(() => useApiDetailQuery("t1", KEYS, fetch), { wrapper: wrapper() });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("keys distinct ids as distinct cache entries", async () => {
    const fetch = vi.fn().mockResolvedValueOnce("a").mockResolvedValueOnce("b");
    const wrap = wrapper();

    const a = renderHook(() => useApiDetailQuery("id-a", KEYS, fetch), { wrapper: wrap });
    await waitFor(() => expect(a.result.current.data).toBe("a"));
    const b = renderHook(() => useApiDetailQuery("id-b", KEYS, fetch), { wrapper: wrap });
    await waitFor(() => expect(b.result.current.data).toBe("b"));

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("parks on the prefix key while disabled, leaving the detail slot untouched", async () => {
    // The parked entry must not land on `detail(id)`, or an id arriving
    // later would read an empty cached row instead of fetching.
    const fetch = vi.fn().mockResolvedValue("row");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useApiDetailQuery(id, KEYS, fetch),
      { wrapper: wrap, initialProps: { id: undefined as string | undefined } },
    );
    expect(client.getQueryData(KEYS.detail("t1"))).toBeUndefined();

    rerender({ id: "t1" });
    await waitFor(() => expect(client.getQueryData(KEYS.detail("t1"))).toBe("row"));
  });

  it("supports a key namespace whose detail factory is not named `detail`", async () => {
    // `useConversation` splices `sessions.conversation` in as `detail`.
    const fetch = vi.fn().mockResolvedValue("convo");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    renderHook(
      () =>
        useApiDetailQuery(
          "s1",
          { all: ["sessions"], detail: (id: string) => ["sessions", "conversation", id] },
          fetch,
        ),
      { wrapper: wrap },
    );

    await waitFor(() =>
      expect(client.getQueryData(["sessions", "conversation", "s1"])).toBe("convo"),
    );
  });
});
