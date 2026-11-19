import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { useEntityQuery } from "./use-entity";

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

const detailKey = (id: string) => ["thing", "detail", id] as const;
const allKey = ["thing"] as const;

describe("useEntityQuery", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("fetches with the id and exposes the result", async () => {
    const fetch = vi.fn().mockResolvedValue({ id: "thing_1" });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () => useEntityQuery("thing_1", detailKey, allKey, fetch),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ id: "thing_1" });
    expect(fetch.mock.calls[0]?.[0]).toBe("thing_1");
  });

  it("never calls the fetcher while the id is undefined", async () => {
    // This is the invariant the five hand-written copies each asserted with
    // an `id as string` cast: the fetcher is unreachable without an id.
    const fetch = vi.fn();
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () => useEntityQuery(undefined, detailKey, allKey, fetch),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("caches under the entity's detail key, not the fallback", async () => {
    const fetch = vi.fn().mockResolvedValue({ id: "thing_1" });
    const { client, Wrapper } = makeWrapper();

    const { result } = renderHook(
      () => useEntityQuery("thing_1", detailKey, allKey, fetch),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(detailKey("thing_1"))).toEqual({ id: "thing_1" });
    expect(client.getQueryData(allKey)).toBeUndefined();
  });

  it("fetches once the id arrives on a later render", async () => {
    // Detail pages mount before the route param resolves, so the id going
    // undefined -> defined is the normal path, not an edge case.
    const fetch = vi.fn().mockResolvedValue({ id: "thing_1" });
    const { Wrapper } = makeWrapper();

    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) =>
        useEntityQuery(id, detailKey, allKey, fetch),
      { wrapper: Wrapper, initialProps: { id: undefined as string | undefined } },
    );

    expect(fetch).not.toHaveBeenCalled();
    rerender({ id: "thing_1" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ id: "thing_1" });
  });

  it("surfaces a failed fetch as an error state", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("boom"));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () => useEntityQuery("thing_1", detailKey, allKey, fetch),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("honors a staleTime passed through the options argument", async () => {
    // `useConversation` relies on this: its payload is every turn of a chat
    // (up to 500 events each), so a remount inside the window must serve
    // the cache rather than refetch.
    const fetch = vi.fn().mockResolvedValue({ id: "thing_1" });
    const { Wrapper } = makeWrapper();
    const render = () =>
      renderHook(
        () => useEntityQuery("thing_1", detailKey, allKey, fetch, { staleTime: 60_000 }),
        { wrapper: Wrapper },
      );

    const first = render();
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = render();
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refetches on remount without a staleTime", async () => {
    // The contrast that gives the test above its meaning: the default is to
    // treat cached data as stale immediately.
    const fetch = vi.fn().mockResolvedValue({ id: "thing_1" });
    const { Wrapper } = makeWrapper();
    const render = () =>
      renderHook(() => useEntityQuery("thing_1", detailKey, allKey, fetch), {
        wrapper: Wrapper,
      });

    const first = render();
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const second = render();
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("forwards an abort signal to the fetcher", async () => {
    const fetch = vi.fn().mockResolvedValue({ id: "thing_1" });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () => useEntityQuery("thing_1", detailKey, allKey, fetch),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not fetch when the API is not configured, even with an id", async () => {
    // Every detail page renders a "not configured" empty state instead, so
    // firing the request would be wasted work against a URL that is null.
    apiState.isApiConfigured = false;
    const fetch = vi.fn();
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () => useEntityQuery("thing_1", detailKey, allKey, fetch),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(fetch).not.toHaveBeenCalled();
  });
});
