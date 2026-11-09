import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const apiState = {
  isApiConfigured: true,
};

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
  apiBaseUrl: "https://api.example.com",
}));

import { useDetailQuery, type DetailQueryKeys } from "./use-detail-query";

const keys: DetailQueryKeys = {
  all: ["thing"] as const,
  detail: (id: string) => ["thing", "detail", id] as const,
};

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function TestQueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  apiState.isApiConfigured = true;
  vi.clearAllMocks();
});

describe("useDetailQuery", () => {
  it("fetches by id and returns the entity", async () => {
    const fetchById = vi.fn().mockResolvedValue({ id: "x1", name: "thing" });
    const { result } = renderHook(() => useDetailQuery("x1", keys, fetchById), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ id: "x1", name: "thing" });
    expect(fetchById).toHaveBeenCalledTimes(1);
    expect(fetchById.mock.calls[0]![0]).toBe("x1");
  });

  it("passes an abort signal through to the fetcher", async () => {
    const fetchById = vi.fn().mockResolvedValue({});
    renderHook(() => useDetailQuery("x1", keys, fetchById), { wrapper: wrapper() });

    await waitFor(() => expect(fetchById).toHaveBeenCalled());
    expect(fetchById.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it("stays disabled and does not fetch while the id is undefined", async () => {
    const fetchById = vi.fn().mockResolvedValue({});
    const { result } = renderHook(() => useDetailQuery(undefined, keys, fetchById), {
      wrapper: wrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchById).not.toHaveBeenCalled();
  });

  it("stays disabled when the api is not configured", async () => {
    apiState.isApiConfigured = false;
    const fetchById = vi.fn().mockResolvedValue({});
    const { result } = renderHook(() => useDetailQuery("x1", keys, fetchById), {
      wrapper: wrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchById).not.toHaveBeenCalled();
  });

  it("caches an id-less query on the resource prefix, not a real detail slot", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(() => useDetailQuery(undefined, keys, vi.fn()), { wrapper: Wrapper });

    expect(client.getQueryCache().find({ queryKey: keys.all })).toBeDefined();
  });

  it("refetches under the new key when the id changes", async () => {
    const fetchById = vi.fn().mockImplementation(async (id: string) => ({ id }));
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useDetailQuery(id, keys, fetchById),
      { wrapper: wrapper(), initialProps: { id: "x1" } },
    );

    await waitFor(() => expect(result.current.data).toEqual({ id: "x1" }));
    rerender({ id: "x2" });
    await waitFor(() => expect(result.current.data).toEqual({ id: "x2" }));
    expect(fetchById.mock.calls.map((c) => c[0])).toEqual(["x1", "x2"]);
  });

  it("forwards extra query options such as staleTime", async () => {
    const fetchById = vi.fn().mockResolvedValue({});
    const { result } = renderHook(
      () => useDetailQuery("x1", keys, fetchById, { staleTime: 60_000 }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.isStale).toBe(false);
  });

  it("surfaces a rejected fetch as an error", async () => {
    const fetchById = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useDetailQuery("x1", keys, fetchById), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("boom"));
  });
});
