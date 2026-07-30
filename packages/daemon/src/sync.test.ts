import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KNOWN_CLIS } from "@beevibe/core";
import { loadConfig, saveConfig, type DaemonConfig } from "./config.js";
import { runSync } from "./sync.js";

const { detectClisMock } = vi.hoisted(() => ({ detectClisMock: vi.fn() }));

vi.mock("./detect-clis.js", () => ({ detectClis: detectClisMock }));

function seedConfig(root: string, overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const config: DaemonConfig = {
    api_url: "http://api.test",
    external_id: "host.test",
    daemon_id: "dmn_1",
    daemon_token: "bv_d_secret",
    runtimes: [{ id: "rt_claude", cli: "claude" }],
    ...overrides,
  };
  saveConfig(config, root);
  return config;
}

function stubFetch(init: { status: number; body?: unknown }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    status: init.status,
    text: async () => (init.body === undefined ? "" : JSON.stringify(init.body)),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "beevibe-sync-test-"));
  detectClisMock.mockReset();
  detectClisMock.mockResolvedValue([{ cli: "claude", cli_version: "1.0.0" }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("runSync", () => {
  it("refuses to run before setup, naming the config path", async () => {
    await expect(runSync({ configRoot: root })).rejects.toThrow(
      /No daemon config at .*config\.json.*beevibe-daemon setup/s,
    );
  });

  it("refuses when no supported CLI is on PATH, listing the ones it looks for", async () => {
    seedConfig(root);
    detectClisMock.mockResolvedValue([]);

    await expect(runSync({ configRoot: root })).rejects.toThrow(
      new RegExp(KNOWN_CLIS.join(", ")),
    );
  });

  it("POSTs the detected CLIs to /runtime/sync with the daemon's bv_d_ token", async () => {
    seedConfig(root);
    detectClisMock.mockResolvedValue([
      { cli: "claude", cli_version: "1.0.0" },
      { cli: "codex", cli_version: "0.9.0" },
    ]);
    const fetchMock = stubFetch({
      status: 200,
      body: {
        runtimes: [
          { id: "rt_claude", cli: "claude" },
          { id: "rt_codex", cli: "codex" },
        ],
      },
    });

    await runSync({ configRoot: root });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://api.test/runtime/sync");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer bv_d_secret",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      runtimes: [
        { cli: "claude", cli_version: "1.0.0" },
        { cli: "codex", cli_version: "0.9.0" },
      ],
    });
  });

  it("reports only the newly-registered CLIs as added and persists the full list", async () => {
    seedConfig(root);
    const runtimes = [
      { id: "rt_claude", cli: "claude" },
      { id: "rt_codex", cli: "codex" },
    ];
    stubFetch({ status: 200, body: { runtimes } });

    const result = await runSync({ configRoot: root });

    expect(result.added).toEqual([{ id: "rt_codex", cli: "codex" }]);
    expect(result.runtimes).toEqual(runtimes);
    expect(loadConfig(root)?.runtimes).toEqual(runtimes);
  });

  it("reports nothing added when the server returns the CLIs already on file", async () => {
    seedConfig(root);
    stubFetch({ status: 200, body: { runtimes: [{ id: "rt_claude", cli: "claude" }] } });

    await expect(runSync({ configRoot: root })).resolves.toMatchObject({ added: [] });
  });

  it("keeps identity fields untouched — sync re-registers CLIs, it does not rotate credentials", async () => {
    const before = seedConfig(root);
    stubFetch({ status: 200, body: { runtimes: [{ id: "rt_new", cli: "claude" }] } });

    await runSync({ configRoot: root });

    const after = loadConfig(root);
    expect(after).toMatchObject({
      api_url: before.api_url,
      external_id: before.external_id,
      daemon_id: before.daemon_id,
      daemon_token: before.daemon_token,
    });
  });

  it.each([
    { status: 401, body: { error: "bad token" }, label: "an auth rejection" },
    { status: 500, body: undefined, label: "a server error with no body" },
    { status: 200, body: undefined, label: "a 200 with an empty body" },
  ])("throws on $label and leaves the stored config alone", async ({ status, body }) => {
    const before = seedConfig(root);
    stubFetch({ status, body });

    await expect(runSync({ configRoot: root })).rejects.toThrow(
      `/runtime/sync failed: ${status}`,
    );
    expect(loadConfig(root)).toEqual(before);
  });
});
