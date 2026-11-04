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
    },
  },
}));

import {
  useApproveTask,
  useRejectTask,
  useReviseTask,
  useCancelTask,
  useTaskReview,
} from "./use-task-mutations";
import { api } from "@/lib/api/client";
import { queryKeys } from "./keys";

const approveMock = vi.mocked(api.tasks.approve);
const rejectMock = vi.mocked(api.tasks.reject);
const reviseMock = vi.mocked(api.tasks.revise);
const cancelMock = vi.mocked(api.tasks.cancel);

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

describe("useTaskReview", () => {
  it("starts closed, with an empty box and nothing submittable", () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTaskReview("t_1"), { wrapper: Wrapper });

    expect(result.current.reviseOpen).toBe(false);
    expect(result.current.feedback).toBe("");
    expect(result.current.canSubmitRevise).toBe(false);
    expect(result.current.anyPending).toBe(false);
    expect(result.current.lastError).toBeNull();
    expect(result.current.lastErrorAction).toBeNull();
  });

  it("toggleRevise opens and closes without clearing the draft", () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTaskReview("t_1"), { wrapper: Wrapper });

    act(() => result.current.setFeedback("half-written"));
    act(() => result.current.toggleRevise());
    expect(result.current.reviseOpen).toBe(true);

    act(() => result.current.toggleRevise());
    expect(result.current.reviseOpen).toBe(false);
    // Collapsing the drawer is not a discard — the draft survives so a
    // mis-click doesn't lose typed feedback.
    expect(result.current.feedback).toBe("half-written");
  });

  it("closeRevise discards the draft", () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTaskReview("t_1"), { wrapper: Wrapper });

    act(() => result.current.setFeedback("scrap this"));
    act(() => result.current.toggleRevise());
    act(() => result.current.closeRevise());

    expect(result.current.reviseOpen).toBe(false);
    expect(result.current.feedback).toBe("");
  });

  it("treats whitespace-only feedback as not submittable", () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTaskReview("t_1"), { wrapper: Wrapper });

    act(() => result.current.setFeedback("   \n  "));
    expect(result.current.canSubmitRevise).toBe(false);

    act(() => result.current.setFeedback("  real feedback  "));
    expect(result.current.canSubmitRevise).toBe(true);
  });

  it("submitRevise sends trimmed feedback, then clears and closes", async () => {
    reviseMock.mockResolvedValue({} as never);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTaskReview("t_1"), { wrapper: Wrapper });

    act(() => result.current.toggleRevise());
    act(() => result.current.setFeedback("  needs more tests \n"));

    await act(async () => {
      result.current.submitRevise();
    });

    await waitFor(() =>
      expect(reviseMock).toHaveBeenCalledWith("t_1", { feedback: "needs more tests" }),
    );
    await waitFor(() => expect(result.current.reviseOpen).toBe(false));
    expect(result.current.feedback).toBe("");
  });

  it("submitRevise is a no-op on whitespace-only feedback", async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTaskReview("t_1"), { wrapper: Wrapper });

    act(() => result.current.toggleRevise());
    act(() => result.current.setFeedback("   "));

    await act(async () => {
      result.current.submitRevise();
    });

    expect(reviseMock).not.toHaveBeenCalled();
    // Still open, so the user can fix the input rather than wonder what
    // happened.
    expect(result.current.reviseOpen).toBe(true);
  });

  it("rolls a failing mutation up into lastError and names the action", async () => {
    rejectMock.mockRejectedValue(new Error("task is not in review"));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTaskReview("t_1"), { wrapper: Wrapper });

    await act(async () => {
      result.current.reject.mutate({});
    });

    await waitFor(() => expect(result.current.lastError?.message).toBe("task is not in review"));
    expect(result.current.lastErrorAction).toBe("reject");
    expect(result.current.anyPending).toBe(false);
  });

  it("keeps the three mutations gating each other via anyPending", async () => {
    let release: (() => void) | undefined;
    approveMock.mockImplementation(
      () => new Promise<never>((resolve) => {
        release = () => resolve(undefined as never);
      }),
    );
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTaskReview("t_1"), { wrapper: Wrapper });

    act(() => {
      result.current.approve.mutate({});
    });

    await waitFor(() => expect(result.current.anyPending).toBe(true));
    // An in-flight approve must block a revise submit too — that is the
    // whole reason the roll-up exists.
    act(() => result.current.setFeedback("something"));
    expect(result.current.canSubmitRevise).toBe(false);

    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(result.current.anyPending).toBe(false));
  });
});
