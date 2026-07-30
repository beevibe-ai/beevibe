import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api-client.js";

const { wsCalls } = vi.hoisted(() => ({
  wsCalls: [] as Array<{ url: string; options: { headers: Record<string, string> } }>,
}));

vi.mock("ws", () => ({
  default: class FakeWebSocket {
    constructor(url: string, options: { headers: Record<string, string> }) {
      wsCalls.push({ url, options });
    }
  },
}));

/** Minimal stand-in for the parts of `Response` ApiClient touches. */
function response(init: { status: number; json?: unknown; text?: string }) {
  return {
    status: init.status,
    json: async () => init.json,
    text: async () =>
      init.text ?? (init.json === undefined ? "" : JSON.stringify(init.json)),
  };
}

function client(): { api: ApiClient; fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  return {
    api: new ApiClient({ apiUrl: "http://api.test", daemonToken: "bv_d_secret" }),
    fetchMock,
  };
}

/** The `init` object handed to the Nth fetch call. */
function initOf(fetchMock: ReturnType<typeof vi.fn>, n = 0): RequestInit {
  return fetchMock.mock.calls[n]?.[1] as RequestInit;
}

beforeEach(() => {
  wsCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiClient.get", () => {
  it("returns the parsed body and sends bearer auth against the configured base URL", async () => {
    const { api, fetchMock } = client();
    fetchMock.mockResolvedValue(response({ status: 200, json: { ok: true } }));

    await expect(api.get("/runtime/skills")).resolves.toEqual({ ok: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://api.test/runtime/skills");
    expect(initOf(fetchMock).headers).toEqual({
      authorization: "Bearer bv_d_secret",
    });
  });

  it.each([
    { status: 204, label: "204 no-content" },
    { status: 401, label: "401 unauthorized" },
    { status: 404, label: "404 not found" },
    { status: 500, label: "500 server error" },
  ])("returns undefined on $label without parsing a body", async ({ status }) => {
    const { api, fetchMock } = client();
    const json = vi.fn();
    fetchMock.mockResolvedValue({ status, json });

    await expect(api.get("/runtime/skills")).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });
});

describe("ApiClient.post", () => {
  it("sends a JSON body with content-type and bearer auth", async () => {
    const { api, fetchMock } = client();
    fetchMock.mockResolvedValue(response({ status: 200, json: { id: "x" } }));

    await api.post("/runtime/events", { events: [{ kind: "agent" }] });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://api.test/runtime/events");
    const init = initOf(fetchMock);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer bv_d_secret",
    });
    expect(init.body).toBe(JSON.stringify({ events: [{ kind: "agent" }] }));
  });

  it("returns status + parsed body on a 200", async () => {
    const { api, fetchMock } = client();
    fetchMock.mockResolvedValue(response({ status: 200, json: { runtimes: [] } }));

    await expect(api.post("/runtime/sync", {})).resolves.toEqual({
      status: 200,
      body: { runtimes: [] },
    });
  });

  it("short-circuits a 204 without reading the body", async () => {
    const { api, fetchMock } = client();
    const text = vi.fn();
    fetchMock.mockResolvedValue({ status: 204, text });

    await expect(api.post("/runtime/done", {})).resolves.toEqual({
      status: 204,
      body: undefined,
    });
    expect(text).not.toHaveBeenCalled();
  });

  it("treats an empty response body as no body, keeping the status", async () => {
    const { api, fetchMock } = client();
    fetchMock.mockResolvedValue(response({ status: 202, text: "" }));

    await expect(api.post("/runtime/done", {})).resolves.toEqual({
      status: 202,
      body: undefined,
    });
  });

  it("swallows unparseable bodies but still reports the status", async () => {
    const { api, fetchMock } = client();
    fetchMock.mockResolvedValue(
      response({ status: 502, text: "<html>bad gateway</html>" }),
    );

    await expect(api.post("/runtime/done", {})).resolves.toEqual({
      status: 502,
      body: undefined,
    });
  });

  it("parses error bodies on 4xx so callers can read the reason", async () => {
    const { api, fetchMock } = client();
    fetchMock.mockResolvedValue(
      response({ status: 409, json: { error: "already claimed" } }),
    );

    await expect(api.post("/runtime/claim", {})).resolves.toEqual({
      status: 409,
      body: { error: "already claimed" },
    });
  });
});

describe("ApiClient.claim", () => {
  it("POSTs /runtime/claim with the runtime id url-encoded into the query", async () => {
    const { api, fetchMock } = client();
    fetchMock.mockResolvedValue(response({ status: 200, json: { session_id: "s1" } }));

    await expect(api.claim("rt/with space")).resolves.toEqual({ session_id: "s1" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://api.test/runtime/claim?runtime_id=rt%2Fwith%20space",
    );
    const init = initOf(fetchMock);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ authorization: "Bearer bv_d_secret" });
  });

  it.each([
    { status: 204, label: "nothing pending (204)" },
    { status: 409, label: "already-claimed race (409)" },
    { status: 404, label: "unknown runtime (404)" },
  ])("returns undefined for $label", async ({ status }) => {
    const { api, fetchMock } = client();
    fetchMock.mockResolvedValue({ status, json: vi.fn() });

    await expect(api.claim("rt_1")).resolves.toBeUndefined();
  });
});

describe("ApiClient.openWebSocket", () => {
  it("swaps http for ws and passes the runtime ids comma-joined", () => {
    const { api } = client();

    api.openWebSocket(["rt_1", "rt_2"]);

    expect(wsCalls).toHaveLength(1);
    expect(wsCalls[0]?.url).toBe(
      "ws://api.test/runtime/ws?runtime_ids=rt_1,rt_2",
    );
    expect(wsCalls[0]?.options.headers).toEqual({
      authorization: "Bearer bv_d_secret",
    });
  });

  it("swaps https for wss", () => {
    vi.stubGlobal("fetch", vi.fn());
    const api = new ApiClient({
      apiUrl: "https://api.beevibe.test",
      daemonToken: "bv_d_secret",
    });

    api.openWebSocket(["rt_1"]);

    expect(wsCalls[0]?.url).toBe(
      "wss://api.beevibe.test/runtime/ws?runtime_ids=rt_1",
    );
  });

  it("url-encodes each runtime id individually, not the joined string", () => {
    const { api } = client();

    api.openWebSocket(["rt a", "rt+b"]);

    expect(wsCalls[0]?.url).toBe(
      "ws://api.test/runtime/ws?runtime_ids=rt%20a,rt%2Bb",
    );
  });
});
