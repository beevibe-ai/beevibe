/**
 * Tests for the shared read-query factories.
 *
 * `useApiDetailQuery` is what the six per-entity detail hooks now run on, so
 * the contract it owns is worth pinning directly rather than only through
 * whichever caller happens to be tested: the `isApiConfigured` gate, the
 * `!!id` gate, the key/fallback-key switch, that the fetcher receives a
 * narrowed `string` id, and that caller extras (`staleTime`, `select`, an
 * additional `enabled`) still reach `useQuery`.
 */
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

const keyFor = (id: string) => ["thing", "detail", id] as const;
const fallbackKey = ["thing"] as const;

beforeEach(() => {
  apiState.isApiConfigured = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useApiQuery", () => {
  it("does not fire when the API is not configured", async () => {
    apiState.isApiConfigured = false;
    const fetch = vi.fn().mockResolvedValue("v");

    const { result } = renderHook(() => useApiQuery(["k"], fetch), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ANDs a caller-supplied enabled with the config gate rather than replacing it", async () => {
    const fetch = vi.fn().mockResolvedValue("v");

    // Config on, caller off → still off.
    const off = renderHook(() => useApiQuery(["k"], fetch, { enabled: false }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(off.result.current.fetchStatus).toBe("idle"));
    expect(fetch).not.toHaveBeenCalled();

    // Config on, caller on → fires.
    const on = renderHook(() => useApiQuery(["k"], fetch, { enabled: true }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(on.result.current.isSuccess).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("passes an abort signal through to the fetcher", async () => {
    const fetch = vi.fn().mockResolvedValue("v");

    const { result } = renderHook(() => useApiQuery(["k"], fetch), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetch.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("applies a caller-supplied select", async () => {
    const fetch = vi.fn().mockResolvedValue({ n: 2 });

    const { result } = renderHook(
      () =>
        useApiQuery<{ n: number }, number>(["k"], fetch, {
          select: (d) => d.n * 10,
        }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(20);
  });
});

describe("useApiDetailQuery", () => {
  it("is disabled when id is undefined, and does not call the fetcher", async () => {
    const fetch = vi.fn().mockResolvedValue("v");

    const { result } = renderHook(
      () => useApiDetailQuery({ id: undefined, keyFor, fallbackKey, fetch }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is disabled when the API is not configured even with an id", async () => {
    apiState.isApiConfigured = false;
    const fetch = vi.fn().mockResolvedValue("v");

    const { result } = renderHook(
      () => useApiDetailQuery({ id: "x1", keyFor, fallbackKey, fetch }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches with the narrowed id when both id and config are present", async () => {
    const fetch = vi.fn().mockResolvedValue("detail");

    const { result } = renderHook(
      () => useApiDetailQuery({ id: "x1", keyFor, fallbackKey, fetch }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe("detail");
    expect(fetch.mock.calls[0]?.[0]).toBe("x1");
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keys distinct ids into distinct cache slots", async () => {
    const fetch = vi.fn(async (id: string) => `v:${id}`);
    const wrap = wrapper();

    const a = renderHook(
      () => useApiDetailQuery({ id: "x1", keyFor, fallbackKey, fetch }),
      { wrapper: wrap },
    );
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));

    const b = renderHook(
      () => useApiDetailQuery({ id: "x2", keyFor, fallbackKey, fetch }),
      { wrapper: wrap },
    );
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true));

    expect(a.result.current.data).toBe("v:x1");
    expect(b.result.current.data).toBe("v:x2");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares one cache slot for the same id", async () => {
    // `staleTime` pins the point: with a shared key the second mount reads the
    // still-fresh slot instead of refetching. Without it TanStack's default
    // `staleTime: 0` refetches on every mount, which would pass regardless of
    // whether the two hooks agreed on a key.
    const fetch = vi.fn().mockResolvedValue("v");
    const wrap = wrapper();
    const opts = { id: "x1", keyFor, fallbackKey, fetch, staleTime: 60_000 };

    const a = renderHook(() => useApiDetailQuery(opts), { wrapper: wrap });
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));

    const b = renderHook(() => useApiDetailQuery(opts), { wrapper: wrap });
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true));

    expect(b.result.current.data).toBe("v");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honours caller extras alongside the id gate", async () => {
    const fetch = vi.fn().mockResolvedValue({ n: 3 });

    const { result } = renderHook(
      () =>
        useApiDetailQuery<{ n: number }, number>({
          id: "x1",
          keyFor,
          fallbackKey,
          fetch,
          staleTime: 60_000,
          select: (d) => d.n + 1,
        }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(4);
  });

  it("stays disabled when the caller's own enabled is false despite a present id", async () => {
    const fetch = vi.fn().mockResolvedValue("v");

    const { result } = renderHook(
      () =>
        useApiDetailQuery({ id: "x1", keyFor, fallbackKey, fetch, enabled: false }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces fetcher errors", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("boom"));

    const { result } = renderHook(
      () => useApiDetailQuery({ id: "x1", keyFor, fallbackKey, fetch }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("boom");
  });
});
