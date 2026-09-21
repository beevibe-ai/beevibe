import { afterEach, describe, expect, it, vi } from "vitest";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
  apiBaseUrl: "https://api.example.com",
}));

import { detailQueryOptions } from "./detail-query";

const keys = {
  all: ["tasks"] as const,
  detail: (id: string) => ["tasks", "detail", id] as const,
};

afterEach(() => {
  apiState.isApiConfigured = true;
});

describe("detailQueryOptions", () => {
  it("keys off the entity once an id exists", () => {
    const opts = detailQueryOptions(keys, vi.fn(), "t1");
    expect(opts.queryKey).toEqual(["tasks", "detail", "t1"]);
    expect(opts.enabled).toBe(true);
  });

  it("falls back to the resource root key while the id is unresolved", () => {
    // Route components mount before their param resolves. The fallback
    // has to be a *stable* key — a changing one would churn the cache —
    // and the query stays disabled, so nothing is written under it.
    const opts = detailQueryOptions(keys, vi.fn(), undefined);
    expect(opts.queryKey).toEqual(["tasks"]);
    expect(opts.enabled).toBe(false);
  });

  it("stays disabled when the api has no base URL configured", () => {
    apiState.isApiConfigured = false;
    expect(detailQueryOptions(keys, vi.fn(), "t1").enabled).toBe(false);
  });

  it("passes the id and the request's abort signal to the fetcher", () => {
    const fetch = vi.fn().mockResolvedValue({ id: "t1" });
    const signal = new AbortController().signal;
    void detailQueryOptions(keys, fetch, "t1").queryFn({ signal });
    expect(fetch).toHaveBeenCalledWith("t1", { signal });
  });

  it("never invokes the fetcher with an undefined id", () => {
    // `queryFn` asserts the id is present; `enabled: false` is what makes
    // that sound. If this pair ever came apart, the five hooks built on
    // it would call their endpoint with "undefined" in the path.
    const fetch = vi.fn();
    const opts = detailQueryOptions(keys, fetch, undefined);
    expect(opts.enabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
