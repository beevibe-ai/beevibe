import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { useAgentSettingMutation } from "./picker-card";
import { queryKeys } from "@/lib/hooks/keys";

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { invalidateSpy, Wrapper };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useAgentSettingMutation", () => {
  it("bumps both the agents and agent-network cache slots on success", async () => {
    // The list view reads through useAgentNetwork() — a separate slot from
    // the per-agent detail. Invalidating one and not the other is what makes
    // a picker look like it silently did nothing in whichever view was missed.
    const setter = vi.fn().mockResolvedValue({ ok: true });
    const { invalidateSpy, Wrapper } = makeWrapper();

    const { result } = renderHook(() => useAgentSettingMutation(setter), {
      wrapper: Wrapper,
    });
    act(() => result.current.mutate("opus"));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // TanStack v5 hands mutationFn a second context arg; the pickers all
    // ignore it, so assert on the value they actually send.
    expect(setter.mock.calls[0]?.[0]).toBe("opus");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.agents.all });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.agentNetwork.all });
  });

  it("passes null through — the unbind / clear signal every picker sends", async () => {
    const setter = vi.fn().mockResolvedValue({ ok: true });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useAgentSettingMutation(setter), {
      wrapper: Wrapper,
    });
    act(() => result.current.mutate(null));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(setter.mock.calls[0]?.[0]).toBeNull();
  });

  it("invalidates nothing when the request fails", async () => {
    const setter = vi.fn().mockRejectedValue(new Error("boom"));
    const { invalidateSpy, Wrapper } = makeWrapper();

    const { result } = renderHook(() => useAgentSettingMutation(setter), {
      wrapper: Wrapper,
    });
    act(() => result.current.mutate("opus"));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
