import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { useDetailQuery } from "./use-detail-query";

const keys = {
  all: ["thing"] as const,
  detail: (id: string) => ["thing", "detail", id] as const,
};

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function TestQueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  apiState.isApiConfigured = true;
  fetchMock = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useDetailQuery", () => {
  it("does not fetch when id is undefined", () => {
    const { result } = renderHook(
      () => useDetailQuery(undefined, keys, fetchMock),
      { wrapper: wrapper() },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it("does not fetch when id is the empty string", () => {
    renderHook(() => useDetailQuery("", keys, fetchMock), { wrapper: wrapper() });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when the API is unconfigured, even with an id", () => {
    apiState.isApiConfigured = false;

    renderHook(() => useDetailQuery("t1", keys, fetchMock), { wrapper: wrapper() });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the narrowed id straight through to the fetcher", async () => {
    fetchMock.mockResolvedValue({ id: "t1" });

    const { result } = renderHook(
      () => useDetailQuery("t1", keys, fetchMock),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The whole point of the factory: `queryFn` only ever runs behind the
    // `enabled` guard, so the fetcher receives a real string — never the
    // `undefined` the public signature admits.
    expect(fetchMock).toHaveBeenCalledWith("t1", expect.objectContaining({}));
    expect(result.current.data).toEqual({ id: "t1" });
  });

  it("caches per id rather than per resource", async () => {
    fetchMock.mockResolvedValueOnce({ id: "a" }).mockResolvedValueOnce({ id: "b" });
    const wrap = wrapper();

    const a = renderHook(() => useDetailQuery("a", keys, fetchMock), { wrapper: wrap });
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));

    const b = renderHook(() => useDetailQuery("b", keys, fetchMock), { wrapper: wrap });
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a.result.current.data).toEqual({ id: "a" });
    expect(b.result.current.data).toEqual({ id: "b" });
  });

  it("re-fetches when the id changes and leaves the prior entry cached", async () => {
    fetchMock.mockImplementation((id: string) => Promise.resolve({ id }));
    const wrap = wrapper();

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        // A non-zero staleTime is what makes "served from cache" observable
        // at all; the test client's default is 0, under which every remount
        // legitimately refetches.
        useDetailQuery(id, keys, fetchMock, { staleTime: 60_000 }),
      { wrapper: wrap, initialProps: { id: "a" } },
    );
    await waitFor(() => expect(result.current.data).toEqual({ id: "a" }));

    rerender({ id: "b" });
    await waitFor(() => expect(result.current.data).toEqual({ id: "b" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Back to "a" — its entry is still cached and still fresh, so no third call.
    rerender({ id: "a" });
    await waitFor(() => expect(result.current.data).toEqual({ id: "a" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("applies per-call overrides without letting them clobber the guard", () => {
    apiState.isApiConfigured = false;

    // `enabled` is deliberately excluded from the overrides type; even if a
    // call site forces one through, the factory's own value wins because it
    // is spread last.
    renderHook(
      () =>
        useDetailQuery("t1", keys, fetchMock, {
          enabled: true,
          staleTime: 60_000,
        } as never),
      { wrapper: wrapper() },
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces fetcher errors", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(
      () => useDetailQuery("t1", keys, fetchMock),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("boom"));
  });
});
