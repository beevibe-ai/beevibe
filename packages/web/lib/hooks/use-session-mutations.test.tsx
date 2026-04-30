import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/lib/api/client", () => ({
  api: {
    sessions: { cancel: vi.fn() },
  },
}));

import { useCancelSession } from "./use-session-mutations";
import { api } from "@/lib/api/client";
import { queryKeys } from "./keys";

const cancelMock = vi.mocked(api.sessions.cancel);

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { invalidateSpy, Wrapper };
}

beforeEach(() => {
  cancelMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useCancelSession", () => {
  it("calls api.sessions.cancel with the shortId and invalidates session + task caches", async () => {
    cancelMock.mockResolvedValue(undefined);
    const { invalidateSpy, Wrapper } = makeWrapper();

    const { result } = renderHook(() => useCancelSession("sess_1", "t_1"), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith("sess_1"));

    const invalidated = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidated).toEqual(
      expect.arrayContaining([
        queryKeys.sessions.detail("sess_1"),
        queryKeys.sessions.all,
        queryKeys.tasks.detail("t_1"),
        queryKeys.tasks.all,
      ]),
    );
  });

  it("skips task-detail invalidation when taskId is omitted", async () => {
    cancelMock.mockResolvedValue(undefined);
    const { invalidateSpy, Wrapper } = makeWrapper();

    const { result } = renderHook(() => useCancelSession("sess_1"), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith("sess_1"));

    const invalidated = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidated).not.toContain(queryKeys.tasks.detail("t_1"));
  });
});
