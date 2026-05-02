import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({
  apiBaseUrl: "https://api.example.com",
  isApiConfigured: true,
  getUserKey: () => null,
}));

import { fetchJson, ApiError } from "./http";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchJson", () => {
  it("issues GET with Accept header against the configured base URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await fetchJson<{ ok: boolean }>("/api/tasks");

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/api/tasks");
    expect(init.method).toBeUndefined();
    expect((init.headers as Record<string, string>).Accept).toBe("application/json");
    expect(init.body).toBeUndefined();
  });

  it("appends query params, skipping undefined and null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await fetchJson<unknown[]>("/api/tasks", {
      query: { view: "mine", limit: 25, archived: false, scope: undefined, owner: null },
    });

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("view")).toBe("mine");
    expect(parsed.searchParams.get("limit")).toBe("25");
    expect(parsed.searchParams.get("archived")).toBe("false");
    expect(parsed.searchParams.has("scope")).toBe(false);
    expect(parsed.searchParams.has("owner")).toBe(false);
  });

  it("serializes JSON body and sets Content-Type when body present", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "t1" }));

    await fetchJson("/api/tasks", { method: "POST", body: { title: "hi" } });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ title: "hi" }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("normalizes paths without leading slash", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await fetchJson("api/tasks");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/api/tasks");
  });

  it("throws ApiError with status + parsed body on non-2xx", async () => {
    const respond = () =>
      new Response(JSON.stringify({ message: "nope" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json" },
      });
    fetchMock.mockResolvedValueOnce(respond()).mockResolvedValueOnce(respond());

    await expect(fetchJson("/api/tasks/missing")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      body: { message: "nope" },
    });
    await expect(fetchJson("/api/tasks/missing")).rejects.toBeInstanceOf(ApiError);
  });

  it("returns undefined for an empty 200 body without throwing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    const result = await fetchJson("/api/no-content");
    expect(result).toBeUndefined();
  });

  it("falls back to raw text when body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("plain text response", {
        status: 500,
        statusText: "ISE",
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(fetchJson("/api/x")).rejects.toMatchObject({
      status: 500,
      body: "plain text response",
    });
  });
});

describe("fetchJson when API is not configured", () => {
  it("throws ApiNotConfigured without invoking fetch", async () => {
    vi.resetModules();
    vi.doMock("./config", () => ({
      apiBaseUrl: null,
      isApiConfigured: false,
      getUserKey: () => null,
    }));

    const { fetchJson: ucFetch, ApiNotConfigured } = await import("./http");
    await expect(ucFetch("/api/tasks")).rejects.toBeInstanceOf(ApiNotConfigured);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.doUnmock("./config");
    vi.resetModules();
  });
});

describe("fetchJson with userKey configured", () => {
  it("attaches Authorization: Bearer <userKey> when getUserKey() returns one", async () => {
    vi.resetModules();
    vi.doMock("./config", () => ({
      apiBaseUrl: "https://api.example.com",
      isApiConfigured: true,
      getUserKey: () => "bv_u_test_key",
    }));

    const { fetchJson: authedFetch } = await import("./http");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await authedFetch("/task/t_1/approve", { method: "POST", body: {} });

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer bv_u_test_key",
    );

    vi.doUnmock("./config");
    vi.resetModules();
  });

  it("invokes the registered onUnauthorized handler on 401", async () => {
    vi.resetModules();
    vi.doMock("./config", () => ({
      apiBaseUrl: "https://api.example.com",
      isApiConfigured: true,
      getUserKey: () => "bv_u_revoked",
    }));

    const { fetchJson: f, setOnUnauthorized } = await import("./http");
    const handler = vi.fn();
    setOnUnauthorized(handler);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(f("/me")).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledOnce();

    vi.doUnmock("./config");
    vi.resetModules();
  });
});
