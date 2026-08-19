/**
 * `beevibe-daemon start` orchestration coverage.
 *
 * `runStart` deliberately never resolves — it ends on a promise that is
 * only broken by `process.exit` from a signal handler. So every case
 * kicks it off without awaiting and waits on the observable side effect
 * (the claimer starting, or the throw on a missing config).
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { runStart } from "./start.js";

const {
  loadConfigMock,
  getConfigRootMock,
  syncSkillsCacheMock,
  apiClientMock,
  claimerMock,
  claimerStartMock,
  claimerStopMock,
  supervisorMock,
  workspaceManagerMock,
  runtimeRegistryMock,
  createDefaultRuntimeRegistryMock,
  logMock,
  warnMock,
} = vi.hoisted(() => {
  const claimerStartMock = vi.fn();
  const claimerStopMock = vi.fn(async () => undefined);
  const runtimeRegistryMock = { registry: true };
  return {
    loadConfigMock: vi.fn(),
    getConfigRootMock: vi.fn(),
    syncSkillsCacheMock: vi.fn(),
    apiClientMock: vi.fn(),
    claimerMock: vi.fn((_config: unknown) => ({
      start: claimerStartMock,
      stop: claimerStopMock,
    })),
    claimerStartMock,
    claimerStopMock,
    supervisorMock: vi.fn(),
    workspaceManagerMock: vi.fn(),
    runtimeRegistryMock,
    createDefaultRuntimeRegistryMock: vi.fn(() => runtimeRegistryMock),
    logMock: vi.fn(),
    warnMock: vi.fn(),
  };
});

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
    getConfigRoot: getConfigRootMock,
  };
});
vi.mock("./skills-cache.js", () => ({ syncSkillsCache: syncSkillsCacheMock }));
vi.mock("./api-client.js", () => ({ ApiClient: apiClientMock }));
vi.mock("./claimer.js", () => ({ Claimer: claimerMock }));
vi.mock("./supervisor.js", () => ({ Supervisor: supervisorMock }));
vi.mock("./logger.js", () => ({
  log: logMock,
  warn: warnMock,
  error: vi.fn(),
}));
vi.mock("@beevibe/core/adapters/local-workspace", () => ({
  LocalWorkspaceManager: workspaceManagerMock,
}));
vi.mock("@beevibe/core/adapters/runtime-registry", () => ({
  createDefaultRuntimeRegistry: createDefaultRuntimeRegistryMock,
}));

const CONFIG = {
  api_url: "http://api.test",
  external_id: "machine-7",
  daemon_id: "dmn_1",
  daemon_token: "bv_d_secret",
  runtimes: [
    { id: "rt_claude", cli: "claude" },
    { id: "rt_codex", cli: "codex" },
  ],
};

const SIGNALS = ["SIGINT", "SIGTERM", "unhandledRejection"] as const;

// `process.listeners`/`removeListener` are typed per-signal; the set
// below mixes a signal-like event in, so go through the plain emitter.
const emitter = process as NodeJS.EventEmitter;

type Listener = (...args: unknown[]) => void;

let exitMock: MockInstance<typeof process.exit>;
let priorListeners: Map<string, Listener[]>;
let workspaceRoot: string | undefined;

/** Start the daemon and wait until the claim loop is running. */
async function start(configRoot?: string): Promise<void> {
  // Floating on purpose: runStart only settles via process.exit.
  void runStart(configRoot === undefined ? {} : { configRoot });
  await vi.waitFor(() => expect(claimerStartMock).toHaveBeenCalled());
}

/** Args the LocalWorkspaceManager was constructed with. */
function workspaceOptions(): Record<string, unknown> {
  return workspaceManagerMock.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  priorListeners = new Map(
    SIGNALS.map(
      (signal) => [signal, emitter.listeners(signal) as Listener[]] as const,
    ),
  );
  workspaceRoot = process.env.WORKSPACE_ROOT;
  delete process.env.WORKSPACE_ROOT;

  loadConfigMock.mockReset().mockReturnValue(CONFIG);
  getConfigRootMock.mockReset().mockReturnValue("/home/test/.beevibe");
  syncSkillsCacheMock.mockReset().mockResolvedValue("/home/test/.beevibe/skills");
  apiClientMock.mockReset();
  claimerMock.mockClear();
  claimerStartMock.mockReset();
  claimerStopMock.mockReset().mockResolvedValue(undefined);
  supervisorMock.mockReset();
  workspaceManagerMock.mockReset();
  createDefaultRuntimeRegistryMock.mockClear();
  logMock.mockReset();
  warnMock.mockReset();
  exitMock = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
});

afterEach(() => {
  // runStart installs signal + unhandledRejection handlers on the shared
  // process object; strip anything this test added so the next file
  // doesn't inherit them.
  for (const signal of SIGNALS) {
    const before = priorListeners.get(signal) ?? [];
    for (const listener of emitter.listeners(signal) as Listener[]) {
      if (!before.includes(listener)) {
        emitter.removeListener(signal, listener);
      }
    }
  }
  if (workspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
  else process.env.WORKSPACE_ROOT = workspaceRoot;
  vi.restoreAllMocks();
});

describe("config gate", () => {
  it("refuses to start without a config, pointing at the setup command", async () => {
    loadConfigMock.mockReturnValue(undefined);

    await expect(runStart()).rejects.toThrow(
      /No daemon config found\. Run `beevibe-daemon setup --api <url> --user-token <bv_u_…>` first\./,
    );
    expect(claimerStartMock).not.toHaveBeenCalled();
    expect(syncSkillsCacheMock).not.toHaveBeenCalled();
  });

  it("reads the config from the requested root", async () => {
    await start("/tmp/root-a");

    expect(loadConfigMock).toHaveBeenCalledWith("/tmp/root-a");
  });
});

describe("wiring", () => {
  it("authenticates the api client with the stored url and daemon token", async () => {
    await start();

    expect(apiClientMock).toHaveBeenCalledWith({
      apiUrl: "http://api.test",
      daemonToken: "bv_d_secret",
    });
  });

  it("points the workspace manager at the api's /mcp endpoint", async () => {
    await start();

    expect(workspaceOptions().mcpServerUrl).toBe("http://api.test/mcp");
    expect(workspaceOptions().runtimeRegistry).toBe(runtimeRegistryMock);
    expect(createDefaultRuntimeRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("subscribes the claimer to every registered runtime id", async () => {
    await start();

    const claimerConfig = claimerMock.mock.calls[0]![0] as {
      runtimeIds: string[];
      runtimeRegistry: unknown;
      api: unknown;
      supervisor: unknown;
      workspaceManager: unknown;
    };
    expect(claimerConfig.runtimeIds).toEqual(["rt_claude", "rt_codex"]);
    expect(claimerConfig.runtimeRegistry).toBe(runtimeRegistryMock);
    expect(claimerConfig.api).toBeInstanceOf(apiClientMock);
    expect(claimerConfig.supervisor).toBeInstanceOf(supervisorMock);
    expect(claimerConfig.workspaceManager).toBeInstanceOf(workspaceManagerMock);
  });

  it("logs the daemon id, api url and runtime count once running", async () => {
    await start();

    expect(logMock).toHaveBeenCalledWith(
      "[daemon] started (dmn_1 → http://api.test, 2 runtime(s))",
    );
  });
});

describe("skills cache", () => {
  it("hands the synced bundle to the workspace manager", async () => {
    await start("/tmp/root-a");

    expect(syncSkillsCacheMock).toHaveBeenCalledWith(
      expect.any(apiClientMock),
      "/tmp/root-a",
    );
    expect(workspaceOptions().skillsSourceDir).toBe("/home/test/.beevibe/skills");
  });

  it("keeps starting on a sync failure, falling back to an empty source", async () => {
    syncSkillsCacheMock.mockRejectedValue(new Error("502 from /skills"));

    await start();

    expect(warnMock).toHaveBeenCalledWith(
      "[daemon] skills sync failed; continuing without skills:",
      "502 from /skills",
    );
    expect(workspaceOptions().skillsSourceDir).toBe("/dev/null");
  });

  it("stringifies a non-Error sync failure", async () => {
    syncSkillsCacheMock.mockRejectedValue("ENOTFOUND api.test");

    await start();

    expect(warnMock).toHaveBeenCalledWith(
      "[daemon] skills sync failed; continuing without skills:",
      "ENOTFOUND api.test",
    );
  });
});

describe("workspace root", () => {
  it("defaults to <configRoot>/workspaces", async () => {
    getConfigRootMock.mockReturnValue("/tmp/root-a");

    await start("/tmp/root-a");

    expect(getConfigRootMock).toHaveBeenCalledWith("/tmp/root-a");
    expect(workspaceOptions().workspaceRoot).toBe(
      join("/tmp/root-a", "workspaces"),
    );
  });

  it("lets WORKSPACE_ROOT win for CI and bespoke layouts", async () => {
    process.env.WORKSPACE_ROOT = "/mnt/ci/workspaces";

    await start();

    expect(workspaceOptions().workspaceRoot).toBe("/mnt/ci/workspaces");
  });

  it("treats an empty WORKSPACE_ROOT as unset", async () => {
    process.env.WORKSPACE_ROOT = "";
    getConfigRootMock.mockReturnValue("/home/test/.beevibe");

    await start();

    expect(workspaceOptions().workspaceRoot).toBe(
      join("/home/test/.beevibe", "workspaces"),
    );
  });
});

describe("shutdown", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "stops the claim loop and exits 0 on %s",
    async (signal) => {
      await start();

      process.emit(signal);
      await vi.waitFor(() => expect(exitMock).toHaveBeenCalled());

      expect(logMock).toHaveBeenCalledWith(
        `[daemon] received ${signal}; stopping`,
      );
      expect(claimerStopMock).toHaveBeenCalledTimes(1);
      expect(exitMock).toHaveBeenCalledWith(0);
    },
  );

  it("ignores a second signal so shutdown never runs twice", async () => {
    await start();

    process.emit("SIGTERM");
    await vi.waitFor(() => expect(claimerStopMock).toHaveBeenCalled());
    process.emit("SIGINT");
    process.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));

    expect(claimerStopMock).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledTimes(1);
    expect(logMock).not.toHaveBeenCalledWith(
      "[daemon] received SIGINT; stopping",
    );
  });
});

describe("unhandled rejections", () => {
  it("logs and keeps the self-healing claim loop alive", async () => {
    await start();

    process.emit("unhandledRejection", new Error("fetch failed"), Promise.resolve());

    expect(warnMock).toHaveBeenCalledWith(
      "[daemon] unhandledRejection (continuing):",
      "fetch failed",
    );
    expect(exitMock).not.toHaveBeenCalled();
    expect(claimerStopMock).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error rejection reason", async () => {
    await start();

    process.emit("unhandledRejection", "socket hang up", Promise.resolve());

    expect(warnMock).toHaveBeenCalledWith(
      "[daemon] unhandledRejection (continuing):",
      "socket hang up",
    );
  });
});
