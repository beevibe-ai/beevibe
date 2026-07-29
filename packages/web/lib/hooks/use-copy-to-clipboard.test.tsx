import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCopyToClipboard } from "./use-copy-to-clipboard";

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
    writable: true,
  });
  return navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
}

describe("useCopyToClipboard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("writes the text and raises the copied flag", async () => {
    const writeText = stubClipboard(async () => {});
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      expect(await result.current.copy("hello")).toBe(true);
    });

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(result.current.copied).toBe(true);
  });

  it("lowers the flag again after the reset window", async () => {
    stubClipboard(async () => {});
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy("hello");
    });
    expect(result.current.copied).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.copied).toBe(false);
  });

  it("does nothing when the clipboard API is unavailable", async () => {
    // Non-secure origins and older browsers have no navigator.clipboard.
    // click-to-copy-id.tsx used to hit an unhandled rejection here.
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      expect(await result.current.copy("hello")).toBe(false);
    });
    expect(result.current.copied).toBe(false);
  });

  it("reports failure without throwing when the write is rejected", async () => {
    stubClipboard(async () => {
      throw new Error("permission denied");
    });
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      expect(await result.current.copy("hello")).toBe(false);
    });
    expect(result.current.copied).toBe(false);
  });

  it("ignores an empty string rather than clearing the clipboard", async () => {
    const writeText = stubClipboard(async () => {});
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      expect(await result.current.copy("")).toBe(false);
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("clears the reset timer on unmount", async () => {
    stubClipboard(async () => {});
    const { result, unmount } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy("hello");
    });
    unmount();

    // The pending reset must not fire into an unmounted component.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
