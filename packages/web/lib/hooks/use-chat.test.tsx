import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/lib/api/client", () => ({
  api: {
    chat: {
      history: vi.fn(),
      send: vi.fn(),
    },
  },
}));

vi.mock("@/lib/api/config", () => ({
  isApiConfigured: true,
}));

import { useChat, isInFlightAfterError } from "./use-chat";
import { api, type ChatHistoryResponse } from "@/lib/api/client";
import { ApiError } from "@/lib/api/http";
import { queryKeys } from "./keys";

const sendMock = vi.mocked(api.chat.send);
const historyMock = vi.mocked(api.chat.history);

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

beforeEach(() => {
  sendMock.mockReset();
  historyMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isInFlightAfterError", () => {
  it("accepts 503 agent_offline + 504 chat_turn_timeout", () => {
    expect(isInFlightAfterError(new ApiError("x", 503, { error: "agent_offline" }))).toBe(true);
    expect(isInFlightAfterError(new ApiError("x", 504, { error: "chat_turn_timeout" }))).toBe(true);
  });

  it("rejects other api errors and non-ApiError values", () => {
    expect(isInFlightAfterError(new ApiError("x", 400, { error: "message_required" }))).toBe(false);
    expect(isInFlightAfterError(new ApiError("x", 429, { error: "chat_rate_limit" }))).toBe(false);
    // 504 with a different errorCode (or no body) is treated as a real failure.
    expect(isInFlightAfterError(new ApiError("x", 504, undefined))).toBe(false);
    expect(isInFlightAfterError(new Error("network down"))).toBe(false);
    expect(isInFlightAfterError(undefined)).toBe(false);
  });
});

describe("useChat — 504 chat_turn_timeout recovery", () => {
  it("keeps the user message + in_flight_session_id and suppresses the banner", async () => {
    // Fresh surface: history is disabled (enabled: !fresh), so api.chat.history
    // never gets called. The slot is owned by onMutate / onSuccess / onError.
    const { client, Wrapper } = makeWrapper();
    sendMock.mockRejectedValueOnce(
      new ApiError("HTTP 504 Gateway Timeout", 504, { error: "chat_turn_timeout" }),
    );

    const { result } = renderHook(() => useChat({ fresh: true }), { wrapper: Wrapper });

    act(() => {
      result.current.send("hi team");
    });

    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isSubmitting).toBe(false));

    // User message survives the error path.
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]?.role).toBe("user");
    expect(result.current.messages[0]?.content).toBe("hi team");

    // Banner is suppressed; thinking indicator still on via server-in-flight.
    expect(result.current.error).toBeNull();
    expect(result.current.pendingSessionId).toMatch(/^sess_/);
    expect(result.current.isPending).toBe(true);

    // `latest` cache slot was seeded for the upcoming ?new=1 strip.
    const latest = client.getQueryData<ChatHistoryResponse>(queryKeys.chat.history(undefined));
    expect(latest?.messages).toHaveLength(1);
    expect(latest?.in_flight_session_id).toBeDefined();
  });

  it("rolls back the optimistic user message on a non-recoverable error", async () => {
    const { Wrapper } = makeWrapper();
    sendMock.mockRejectedValueOnce(
      new ApiError("HTTP 429 Too Many Requests", 429, { error: "chat_rate_limit" }),
    );

    const { result } = renderHook(() => useChat({ fresh: true }), { wrapper: Wrapper });

    act(() => {
      result.current.send("hi team");
    });

    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isSubmitting).toBe(false));

    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.pendingSessionId).toBeUndefined();
  });
});
