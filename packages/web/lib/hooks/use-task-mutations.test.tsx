import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/lib/api/client", () => ({
  api: {
    tasks: {
      approve: vi.fn(),
      cancel: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import {
  useApproveTask,
  useCancelTask,
  useCreateTask,
} from "./use-task-mutations";
import { api } from "@/lib/api/client";
import { queryKeys } from "./keys";

const approveMock = vi.mocked(api.tasks.approve);
const cancelMock = vi.mocked(api.tasks.cancel);
const createMock = vi.mocked(api.tasks.create);

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, invalidateSpy, Wrapper };
}

beforeEach(() => {
  approveMock.mockReset();
  cancelMock.mockReset();
  createMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useApproveTask", () => {
  it("calls api.tasks.approve with the input and invalidates task + dashboard caches", async () => {
    approveMock.mockResolvedValue({} as never);
    const { invalidateSpy, Wrapper } = makeWrapper();

    const { result } = renderHook(() => useApproveTask("t_1"), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ action: "approve" });
    });

    await waitFor(() => expect(approveMock).toHaveBeenCalledWith("t_1", { action: "approve" }));

    const invalidated = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidated).toEqual(
      expect.arrayContaining([
        queryKeys.tasks.detail("t_1"),
        queryKeys.tasks.all,
        queryKeys.dashboard.all,
      ]),
    );
  });

  it("surfaces errors via mutation state", async () => {
    approveMock.mockRejectedValue(new Error("nope"));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useApproveTask("t_1"), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ action: "reject" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("nope"));
  });
});

describe("useCancelTask", () => {
  it("calls api.tasks.cancel with no args by default", async () => {
    cancelMock.mockResolvedValue({} as never);
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useCancelTask("t_1"), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate(undefined as never);
    });

    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith("t_1", {}));
  });

  it("forwards cancel input when provided", async () => {
    cancelMock.mockResolvedValue({} as never);
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useCancelTask("t_1"), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ force: true, reason: "scope" });
    });

    await waitFor(() =>
      expect(cancelMock).toHaveBeenCalledWith("t_1", { force: true, reason: "scope" }),
    );
  });
});

describe("useCreateTask", () => {
  it("calls api.tasks.create and invalidates the task list", async () => {
    createMock.mockResolvedValue({} as never);
    const { invalidateSpy, Wrapper } = makeWrapper();

    const { result } = renderHook(() => useCreateTask(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ title: "wire" });
    });

    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ title: "wire" }));

    const invalidated = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidated).toEqual(
      expect.arrayContaining([queryKeys.tasks.all, queryKeys.dashboard.all]),
    );
  });
});
