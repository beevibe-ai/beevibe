import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { TaskListItem } from "@/lib/types/tasks";
import type { TaskDetail } from "@/lib/api/types";

const apiState = {
  isApiConfigured: true,
};

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
  apiBaseUrl: "https://api.example.com",
}));

vi.mock("@/lib/api/client", () => ({
  api: {
    tasks: {
      list: vi.fn(),
      get: vi.fn(),
    },
  },
}));

import { useTasks, useTask } from "./use-tasks";
import { api } from "@/lib/api/client";

const listMock = vi.mocked(api.tasks.list);
const getMock = vi.mocked(api.tasks.get);

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function TestQueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const sampleTask: TaskListItem = {
  id: "t1",
  title: "sample",
  status: "in_progress",
  priority: "medium",
  creator_id: "u1",
  creator_type: "person",
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  apiState.isApiConfigured = true;
  listMock.mockReset();
  getMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useTasks", () => {
  it("does not fire the request when API is not configured", async () => {
    apiState.isApiConfigured = false;
    listMock.mockResolvedValue([sampleTask]);

    const { result } = renderHook(() => useTasks(), { wrapper: wrapper() });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("calls api.tasks.list with the filter and resolves to its return value", async () => {
    listMock.mockResolvedValue([sampleTask]);

    const { result } = renderHook(() => useTasks({ view: "mine" }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([sampleTask]);
    expect(listMock).toHaveBeenCalledWith({ view: "mine" }, expect.objectContaining({}));
  });

  it("treats different filters as separate cache entries", async () => {
    listMock.mockResolvedValueOnce([sampleTask]).mockResolvedValueOnce([]);

    const wrap = wrapper();
    const a = renderHook(() => useTasks({ view: "mine" }), { wrapper: wrap });
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));
    const b = renderHook(() => useTasks({ view: "mine" }), { wrapper: wrap });
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true));

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(listMock).toHaveBeenNthCalledWith(1, { view: "mine" }, expect.objectContaining({}));
    expect(listMock).toHaveBeenNthCalledWith(2, { view: "mine" }, expect.objectContaining({}));
  });

  it("surfaces errors from the api", async () => {
    listMock.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useTasks(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("boom"));
  });
});

describe("useTask", () => {
  const detail = {
    ...sampleTask,
    work_products: [],
    sessions: [],
  } as unknown as TaskDetail;

  it("is disabled when id is undefined", async () => {
    const { result } = renderHook(() => useTask(undefined), { wrapper: wrapper() });
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("is disabled when API is not configured even with an id", async () => {
    apiState.isApiConfigured = false;
    const { result } = renderHook(() => useTask("t1"), { wrapper: wrapper() });
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("fetches the detail when both id and config are present", async () => {
    getMock.mockResolvedValue(detail);
    const { result } = renderHook(() => useTask("t1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith("t1", expect.objectContaining({}));
    expect(result.current.data).toEqual(detail);
  });
});
