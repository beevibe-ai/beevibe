import { beforeEach, describe, expect, it, vi } from "vitest";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { resolveDetailState } from "./detail-state";

const settled = { isLoading: false, isError: false };

describe("resolveDetailState", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("resolves to the row once the fetch succeeded", () => {
    const state = resolveDetailState("task", "t_1", { ...settled, data: { id: "t_1" } });
    expect(state).toEqual({ kind: "ready", data: { id: "t_1" } });
  });

  it("resolves to loading while the query is in flight", () => {
    const state = resolveDetailState("task", "t_1", {
      data: undefined,
      isLoading: true,
      isError: false,
    });
    expect(state.kind).toBe("loading");
  });

  // An unconfigured API is reported as itself rather than surfacing as a
  // mystery fetch failure, so this branch has to win even when the query
  // has also errored.
  it("reports an unconfigured API ahead of a failed fetch", () => {
    apiState.isApiConfigured = false;
    const state = resolveDetailState("task", "t_1", {
      data: undefined,
      isLoading: false,
      isError: true,
    });
    expect(state.kind).toBe("unconfigured");
  });

  // A query can settle without erroring and still hand back nothing (a 404
  // mapped to undefined). That has to land on the error state, so callers
  // never get a `ready` carrying no row.
  it("treats settled-but-empty as a failed fetch", () => {
    const state = resolveDetailState("task", "t_1", { ...settled, data: undefined });
    expect(state.kind).toBe("error");
  });

  describe("copy", () => {
    it("names one process in the unconfigured description", () => {
      apiState.isApiConfigured = false;
      const state = resolveDetailState("work product", "wp_42", {
        ...settled,
        data: undefined,
      });
      expect(state).toMatchObject({
        title: "API not configured",
        description:
          "Set NEXT_PUBLIC_BV_API_URL and run the API server to load this work product.",
      });
    });

    it("sentence-cases the noun and echoes the id in the error description", () => {
      const state = resolveDetailState("work product", "wp_42", {
        ...settled,
        data: undefined,
      });
      expect(state).toMatchObject({
        title: "Couldn't load work product",
        description: "Work product wp_42 could not be fetched. Check the API server logs.",
      });
    });
  });
});
