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

import { useCollectionQuery, useEntityQuery } from "./entity-query";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function TestQueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const detailKey = (id: string) => ["thing", "detail", id] as const;
const allKey = ["thing"] as const;

beforeEach(() => {
  apiState.isApiConfigured = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useEntityQuery", () => {
  it("fetches with the id once both id and config are present", async () => {
    const fetch = vi.fn().mockResolvedValue({ id: "x1" });

    const { result } = renderHook(
      () => useEntityQuery({ id: "x1", queryKey: detailKey, disabledKey: allKey, fetch }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetch).toHaveBeenCalledWith("x1", expect.objectContaining({}));
    expect(result.current.data).toEqual({ id: "x1" });
  });

  it("stays disabled while the id is undefined", () => {
    const fetch = vi.fn().mockResolvedValue({ id: "x1" });

    const { result } = renderHook(
      () => useEntityQuery({ id: undefined, queryKey: detailKey, disabledKey: allKey, fetch }),
      { wrapper: wrapper() },
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("treats an empty-string id as absent rather than fetching /''", () => {
    const fetch = vi.fn().mockResolvedValue({ id: "" });

    renderHook(
      () => useEntityQuery({ id: "", queryKey: detailKey, disabledKey: allKey, fetch }),
      { wrapper: wrapper() },
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it("stays disabled when the api is unconfigured, even with an id", () => {
    apiState.isApiConfigured = false;
    const fetch = vi.fn().mockResolvedValue({ id: "x1" });

    renderHook(
      () => useEntityQuery({ id: "x1", queryKey: detailKey, disabledKey: allKey, fetch }),
      { wrapper: wrapper() },
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives each id its own cache slot", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ id: "a" })
      .mockResolvedValueOnce({ id: "b" });
    const wrap = wrapper();

    const a = renderHook(
      () => useEntityQuery({ id: "a", queryKey: detailKey, disabledKey: allKey, fetch }),
      { wrapper: wrap },
    );
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));

    const b = renderHook(
      () => useEntityQuery({ id: "b", queryKey: detailKey, disabledKey: allKey, fetch }),
      { wrapper: wrap },
    );
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true));

    expect(a.result.current.data).toEqual({ id: "a" });
    expect(b.result.current.data).toEqual({ id: "b" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("passes extra useQuery options through", async () => {
    const fetch = vi.fn().mockResolvedValue({ id: "x1", n: 2 });

    const { result } = renderHook(
      () =>
        useEntityQuery({
          id: "x1",
          queryKey: detailKey,
          disabledKey: allKey,
          fetch,
          select: (d: { id: string; n: number }) => d.n,
        }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(2);
  });

  it("surfaces api errors", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("boom"));

    const { result } = renderHook(
      () => useEntityQuery({ id: "x1", queryKey: detailKey, disabledKey: allKey, fetch }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("boom"));
  });
});

describe("useCollectionQuery", () => {
  it("fetches when the api is configured", async () => {
    const fetch = vi.fn().mockResolvedValue([1, 2]);

    const { result } = renderHook(
      () => useCollectionQuery({ queryKey: ["things", "list"], fetch }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([1, 2]);
  });

  it("does not fire when the api is unconfigured", () => {
    apiState.isApiConfigured = false;
    const fetch = vi.fn().mockResolvedValue([]);

    const { result } = renderHook(
      () => useCollectionQuery({ queryKey: ["things", "list"], fetch }),
      { wrapper: wrapper() },
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it("passes extra useQuery options through", async () => {
    const fetch = vi.fn().mockResolvedValue([1, 2, 3]);

    const { result } = renderHook(
      () =>
        useCollectionQuery({
          queryKey: ["things", "list"],
          fetch,
          select: (d: number[]) => d.length,
        }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(3);
  });
});
