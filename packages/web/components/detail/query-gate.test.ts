import { beforeEach, describe, expect, it, vi } from "vitest";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { gateState } from "./query-gate";

const idle = { isLoading: false, isError: false };

describe("gateState", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("reports ready with the row narrowed to non-undefined", () => {
    const state = gateState("task", "t_1", { ...idle, data: { title: "Ship it" } });
    expect(state.kind).toBe("ready");
    // The narrowing is the whole point — callers stop re-deriving `!data`.
    if (state.kind === "ready") expect(state.data.title).toBe("Ship it");
  });

  it("checks the unconfigured client before the failed fetch", () => {
    // An unconfigured client also reports isError. Flipping this order
    // would tell the user to go read logs for a server they never
    // pointed at.
    apiState.isApiConfigured = false;
    const state = gateState("agent", "a_1", { data: undefined, isLoading: false, isError: true });
    expect(state.kind).toBe("unconfigured");
  });

  it("treats a successful-but-empty query as an error, not as ready", () => {
    // isError stays false when the request resolved with no row, so the
    // data check has to carry this branch on its own.
    const state = gateState("task", "t_9", { ...idle, data: undefined });
    expect(state.kind).toBe("error");
  });

  it("names the process once, in both messages", () => {
    // The drift this replaces: "the api server" / "the API server" /
    // "the MCP server" for one process, and half the surfaces dropping
    // the logs hint.
    apiState.isApiConfigured = false;
    const unconfigured = gateState("task", "t_1", { ...idle, data: undefined });
    apiState.isApiConfigured = true;
    const failed = gateState("task", "t_1", { ...idle, data: undefined });

    expect(unconfigured.kind === "unconfigured" && unconfigured.description).toBe(
      "Set NEXT_PUBLIC_BV_API_URL and run the API server to load this task.",
    );
    expect(failed.kind === "error" && failed.description).toBe(
      "Task t_1 could not be fetched. Check the API server logs.",
    );
  });

  it("capitalizes only the leading noun in the error body", () => {
    // "Work product wp_1 could not be fetched" — not "Work Product".
    const state = gateState("work product", "wp_1", { ...idle, data: undefined });
    expect(state.kind === "error" && state.title).toBe("Couldn't load work product");
    expect(state.kind === "error" && state.description).toMatch(
      /^Work product wp_1 could not be fetched\./,
    );
  });

  it("prefers loading over the error branch", () => {
    // react-query reports isLoading with data still undefined on the
    // first fetch; that must not read as a failure.
    const state = gateState("task", "t_1", { data: undefined, isLoading: true, isError: false });
    expect(state.kind).toBe("loading");
  });
});
