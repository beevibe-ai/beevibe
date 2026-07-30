import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KNOWN_CLIS } from "@beevibe/core";
import { loadConfig } from "./config.js";
import { runSetup, type SetupOptions } from "./setup.js";

const { detectClisMock } = vi.hoisted(() => ({ detectClisMock: vi.fn() }));

vi.mock("./detect-clis.js", () => ({ detectClis: detectClisMock }));

const REGISTERED = {
  daemon_id: "dmn_1",
  daemon_token: "bv_d_secret",
  runtimes: [{ id: "rt_claude", cli: "claude" }],
};

function stubFetch(
  init: { status: number; body?: unknown; text?: string } = { status: 200, body: REGISTERED },
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    status: init.status,
    json: async () => init.body,
    text: async () => init.text ?? JSON.stringify(init.body ?? {}),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

let root: string;

function options(overrides: Partial<SetupOptions> = {}): SetupOptions {
  return {
    apiUrl: "http://api.test",
    userToken: "bv_u_human",
    detectedClis: [{ cli: "claude", cli_version: "1.0.0" }],
    configRoot: root,
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "beevibe-setup-test-"));
  detectClisMock.mockReset();
  detectClisMock.mockResolvedValue([{ cli: "claude", cli_version: "1.0.0" }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("runSetup validation", () => {
  it.each(["api.test", "ftp://api.test", ""])(
    "rejects %j as an --api value before touching the network",
    async (apiUrl) => {
      const fetchMock = stubFetch();

      await expect(runSetup(options({ apiUrl }))).rejects.toThrow(
        /--api must be an http\(s\) URL/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a token that is not a bv_u_ user token", async () => {
    stubFetch();

    await expect(runSetup(options({ userToken: "bv_d_daemon" }))).rejects.toThrow(
      /--user-token must start with bv_u_/,
    );
  });

  it("refuses to register a machine with no supported CLI, listing what it looks for", async () => {
    stubFetch();

    await expect(runSetup(options({ detectedClis: [] }))).rejects.toThrow(
      new RegExp(KNOWN_CLIS.join(", ")),
    );
  });

  it("probes PATH when no CLIs were injected", async () => {
    stubFetch();

    await runSetup(options({ detectedClis: undefined }));

    expect(detectClisMock).toHaveBeenCalledTimes(1);
  });
});

describe("runSetup registration", () => {
  it("POSTs /runtime/register with the user token and the detected CLIs", async () => {
    const fetchMock = stubFetch();

    await runSetup(
      options({
        detectedClis: [
          { cli: "claude", cli_version: "1.0.0" },
          { cli: "codex" },
        ],
      }),
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://api.test/runtime/register");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer bv_u_human",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      external_id: hostname(),
      device_name: `${userInfo().username}@${hostname()}`,
      runtimes: [{ cli: "claude", cli_version: "1.0.0" }, { cli: "codex" }],
    });
  });

  it("honours explicit external_id and device_name overrides", async () => {
    const fetchMock = stubFetch();

    await runSetup(
      options({ externalId: "ci-runner-7", deviceName: "CI runner #7" }),
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({
      external_id: "ci-runner-7",
      device_name: "CI runner #7",
    });
  });

  it("persists the server-issued identity under the given config root", async () => {
    stubFetch();

    const config = await runSetup(options({ externalId: "host.test" }));

    expect(config).toEqual({
      api_url: "http://api.test",
      external_id: "host.test",
      daemon_id: "dmn_1",
      daemon_token: "bv_d_secret",
      runtimes: [{ id: "rt_claude", cli: "claude" }],
    });
    expect(loadConfig(root)).toEqual(config);
  });

  it.each([200, 201])("accepts a %i from /runtime/register", async (status) => {
    stubFetch({ status, body: REGISTERED });

    await expect(runSetup(options())).resolves.toMatchObject({ daemon_id: "dmn_1" });
  });

  it("surfaces the status and body when registration is rejected, writing no config", async () => {
    stubFetch({ status: 401, text: "invalid user token" });

    await expect(runSetup(options())).rejects.toThrow(
      "/runtime/register failed: 401 invalid user token",
    );
    expect(loadConfig(root)).toBeUndefined();
  });
});
