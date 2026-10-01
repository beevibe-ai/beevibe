import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCollapsible } from "./use-collapsible";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCollapsible", () => {
  it("starts on the default when nothing is stored", () => {
    const { result } = renderHook(() => useCollapsible("k"));
    expect(result.current[0]).toBe(false);

    const withDefault = renderHook(() => useCollapsible("k2", true));
    expect(withDefault.result.current[0]).toBe(true);
  });

  it("loads the stored value on mount, overriding the default both ways", () => {
    window.localStorage.setItem("stored-true", "true");
    const collapsed = renderHook(() => useCollapsible("stored-true", false));
    expect(collapsed.result.current[0]).toBe(true);

    window.localStorage.setItem("stored-false", "false");
    const expanded = renderHook(() => useCollapsible("stored-false", true));
    expect(expanded.result.current[0]).toBe(false);
  });

  it("ignores a stored value that isn't the literal 'true'/'false'", () => {
    window.localStorage.setItem("junk", "yes");
    const { result } = renderHook(() => useCollapsible("junk", true));
    expect(result.current[0]).toBe(true);
  });

  it("toggle flips the value and persists it as a string", () => {
    const { result } = renderHook(() => useCollapsible("k"));

    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem("k")).toBe("true");

    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem("k")).toBe("false");
  });

  it("re-reads when the storage key changes", () => {
    window.localStorage.setItem("a", "false");
    window.localStorage.setItem("b", "true");
    const { result, rerender } = renderHook(({ key }) => useCollapsible(key), {
      initialProps: { key: "a" },
    });
    expect(result.current[0]).toBe(false);

    rerender({ key: "b" });
    expect(result.current[0]).toBe(true);
  });

  it("stays on the default when reading localStorage throws", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useCollapsible("k", true));
    expect(result.current[0]).toBe(true);
  });

  it("still toggles in memory when writing localStorage throws", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => useCollapsible("k"));

    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
  });
});
