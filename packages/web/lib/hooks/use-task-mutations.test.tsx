import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/lib/api/client", () => ({
  api: {
    tasks: {
      approve: vi.fn(),
      reject: vi.fn(),
      revise: vi.fn(),
      cancel: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import {
  useApproveTask,
  useRejectTask,
  useReviseTask,
  useCancelTask,
  useCreateTask,
} from "./use-task-mutations";
import { api } from "@/lib/api/client";
import { queryKeys } from "./keys";

const approveMock = vi.mocked(api.tasks.approve);
const rejectMock = vi.mocked(api.tasks.reject);
const reviseMock = vi.mocked(api.tasks.revise);
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
  rejectMock.mockReset();
  reviseMock.mockReset();
  cancelMock.mockReset();
  createMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useApproveTask", () => {
  it("calls api.tasks.approve and invalidates task + dashboard caches", async () => {
    approveMock.mockResolvedValue({} as never);
    const { invalidateSpy, Wrapper } = makeWrapper();

    const { result } = renderHook(() => useApproveTask("t_1"), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({});
    });

    await waitFor(() => expect(approveMock).toHaveBeenCalledWith("t_1", {}));

    const invalidated = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidated).toEqual(
      expect.arrayContaining([
        queryKeys.tasks.detail("t_1"),
        queryKeys.tasks.all,
        queryKeys.dashboard.all,
        // Approve transitions the task out of `review`, which is the
        // entire population of the inbox's task_review branch. Without
        // this invalidation the row lingers in the sidebar until the
        // user navigates away and back.
        queryKeys.inbox.all,
      ]),
    );
  });

  it("surfaces errors via mutation state", async () => {
    approveMock.mockRejectedValue(new Error("nope"));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useApproveTask("t_1"), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({});
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("nope"));
  });
});

describe("useRejectTask", () => {
  it("calls api.tasks.reject and invalidates the same caches", async () => {
    rejectMock.mockResolvedValue({} as never);
    const { invalidateSpy, Wrapper } = makeWrapper();

    const { result } = renderHook(() => useRejectTask("t_1"), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ result_summary: "wrong scope" });
    });

    await waitFor(() =>
      expect(rejectMock).toHaveBeenCalledWith("t_1", { result_summary: "wrong scope" }),
    );

    const invalidated = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidated).toEqual(
      expect.arrayContaining([
        queryKeys.tasks.detail("t_1"),
        queryKeys.tasks.all,
        queryKeys.dashboard.all,
      ]),
    );
  });
});

describe("useReviseTask", () => {
  it("calls api.tasks.revise with the feedback body", async () => {
    reviseMock.mockResolvedValue({} as never);
    const { invalidateSpy, Wrapper } = makeWrapper();

    const { result } = renderHook(() => useReviseTask("t_1"), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ feedback: "needs more tests" });
    });

    await waitFor(() =>
      expect(reviseMock).toHaveBeenCalledWith("t_1", { feedback: "needs more tests" }),
    );

    const invalidated = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidated).toEqual(
      expect.arrayContaining([
        queryKeys.tasks.detail("t_1"),
        queryKeys.tasks.all,
        queryKeys.dashboard.all,
      ]),
    );
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
      result.current.mutate({ reason: "scope" });
    });

    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith("t_1", { reason: "scope" }));
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
