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

import { useDetailQuery } from "./detail-query";

const KEYS = {
  all: ["widgets"] as const,
  detail: (id: string) => ["widgets", "detail", id] as const,
};

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    Wrapper: function TestQueryWrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    },
  };
}

const fetchWidget = vi.fn();

function render(id: string | undefined, staleTime?: number) {
  const { client, Wrapper } = wrapper();
  const hook = renderHook(
    () =>
      useDetailQuery({
        id,
        key: KEYS.detail,
        fallbackKey: KEYS.all,
        fetch: fetchWidget,
        ...(staleTime === undefined ? {} : { staleTime }),
      }),
    { wrapper: Wrapper },
  );
  return { ...hook, client };
}

beforeEach(() => {
  apiState.isApiConfigured = true;
  fetchWidget.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useDetailQuery", () => {
  it("fetches by id and forwards an abort signal", async () => {
    fetchWidget.mockResolvedValue({ id: "w1" });
    const { result } = render("w1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ id: "w1" });
    expect(fetchWidget).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  // The whole point of centralising the non-null assertion: neither gate
  // may fire the request on its own, or the app issues GET /widget/undefined.
  it("does not fetch without an id", () => {
    const { result } = render(undefined);
    expect(fetchWidget).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("does not fetch when the API is unconfigured, even with an id", () => {
    apiState.isApiConfigured = false;
    render("w1");
    expect(fetchWidget).not.toHaveBeenCalled();
  });

  it("parks the idle query on the resource prefix, not a detail slot", () => {
    const { client } = render(undefined);
    const keys = client.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toEqual([["widgets"]]);
  });

  it("keys each id in its own cache slot", async () => {
    fetchWidget.mockResolvedValue({ id: "w1" });
    const { client } = render("w1");
    await waitFor(() =>
      expect(client.getQueryCache().find({ queryKey: KEYS.detail("w1") })).toBeDefined(),
    );
    expect(client.getQueryCache().find({ queryKey: KEYS.detail("w2") })).toBeUndefined();
  });

  // `useConversation` is the one caller that sets staleTime, so the option
  // has to survive the pass-through — observable here as the result not
  // going stale the moment it resolves.
  it("passes staleTime through when given", async () => {
    fetchWidget.mockResolvedValue({ id: "w1" });
    const { result } = render("w1", 60_000);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.isStale).toBe(false);
  });

  it("leaves staleTime to the client default when omitted", async () => {
    fetchWidget.mockResolvedValue({ id: "w1" });
    const { result } = render("w1");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.isStale).toBe(true);
  });

  it("surfaces a rejection as an error state", async () => {
    fetchWidget.mockRejectedValue(new Error("boom"));
    const { result } = render("w1");
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("boom"));
  });
});
