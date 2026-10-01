import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfig } from "./config.js";

const {
  loadConfigMock,
  getConfigRootMock,
  syncSkillsCacheMock,
  claimerStartMock,
  claimerStopMock,
  claimerCtorMock,
  supervisorCtorMock,
  apiClientCtorMock,
  workspaceCtorMock,
  runtimeRegistryMock,
  logMock,
  warnMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  getConfigRootMock: vi.fn(),
  syncSkillsCacheMock: vi.fn(),
  claimerStartMock: vi.fn(),
  claimerStopMock: vi.fn(),
  claimerCtorMock: vi.fn(),
  supervisorCtorMock: vi.fn(),
  apiClientCtorMock: vi.fn(),
  workspaceCtorMock: vi.fn(),
  runtimeRegistryMock: vi.fn(),
  logMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock("./config.js", () => ({
  loadConfig: loadConfigMock,
  getConfigRoot: getConfigRootMock,
}));
vi.mock("./logger.js", () => ({ log: logMock, warn: warnMock, error: vi.fn() }));
vi.mock("./skills-cache.js", () => ({ syncSkillsCache: syncSkillsCacheMock }));
vi.mock("./api-client.js", () => ({
  ApiClient: class {
    constructor(opts: unknown) {
      apiClientCtorMock(opts);
    }
  },
}));
vi.mock("./claimer.js", () => ({
  Claimer: class {
    start = claimerStartMock;
    stop = claimerStopMock;
    constructor(opts: unknown) {
      claimerCtorMock(opts);
    }
  },
}));
vi.mock("./supervisor.js", () => ({
  Supervisor: class {
    constructor() {
      supervisorCtorMock();
    }
  },
}));
vi.mock("@beevibe/core/adapters/local-workspace", () => ({
  LocalWorkspaceManager: class {
    constructor(opts: unknown) {
      workspaceCtorMock(opts);
    }
  },
}));
vi.mock("@beevibe/core/adapters/runtime-registry", () => ({
  createDefaultRuntimeRegistry: runtimeRegistryMock,
}));

import { runStart } from "./start.js";

function config(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    api_url: "http://api.test",
    external_id: "ext_1",
    daemon_id: "dmn_1",
    daemon_token: "bv_d_secret",
    runtimes: [
      { id: "rt_1", cli: "claude" },
      { id: "rt_2", cli: "codex" },
    ],
    ...overrides,
  };
}

/**
 * `runStart` deliberately never resolves — it ends on a pending promise to
 * hold the process open. Kick it off, let the awaits inside settle, and
 * assert on the wiring it performed on the way.
 */
async function startAndSettle(options: Parameters<typeof runStart>[0] = {}): Promise<void> {
  void runStart(options).catch(() => undefined);
  // Two macrotask turns: one for the skills sync await, one for the
  // registry/claimer wiring that follows it.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const SIGNAL_EVENTS = ["SIGINT", "SIGTERM", "unhandledRejection"] as const;

let originalWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalWorkspaceRoot = process.env.WORKSPACE_ROOT;
  delete process.env.WORKSPACE_ROOT;
  getConfigRootMock.mockReturnValue("/home/u/.beevibe");
  syncSkillsCacheMock.mockResolvedValue("/home/u/.beevibe/skills");
  runtimeRegistryMock.mockReturnValue({ registry: true });
  claimerStopMock.mockResolvedValue(undefined);
});

afterEach(() => {
  if (originalWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
  else process.env.WORKSPACE_ROOT = originalWorkspaceRoot;
  // runStart installs process-level handlers; drop them so cases don't
  // leak listeners into each other or trip Node's max-listeners warning.
  for (const ev of SIGNAL_EVENTS) process.removeAllListeners(ev);
  vi.restoreAllMocks();
});

describe("runStart — no config", () => {
  it("rejects with the setup hint and wires nothing", async () => {
    loadConfigMock.mockReturnValue(undefined);

    await expect(runStart()).rejects.toThrow(/No daemon config found/);
    await expect(runStart()).rejects.toThrow(/beevibe-daemon setup --api/);
    expect(apiClientCtorMock).not.toHaveBeenCalled();
    expect(claimerStartMock).not.toHaveBeenCalled();
  });

  it("passes the configRoot override through to loadConfig", async () => {
    loadConfigMock.mockReturnValue(undefined);

    await expect(runStart({ configRoot: "/tmp/root" })).rejects.toThrow();
    expect(loadConfigMock).toHaveBeenCalledWith("/tmp/root");
  });
});

describe("runStart — wiring", () => {
  it("builds the api client from the config's url and token", async () => {
    loadConfigMock.mockReturnValue(config());

    await startAndSettle();

    expect(apiClientCtorMock).toHaveBeenCalledWith({
      apiUrl: "http://api.test",
      daemonToken: "bv_d_secret",
    });
  });

  it("syncs the skills cache before building the workspace manager", async () => {
    loadConfigMock.mockReturnValue(config());

    await startAndSettle({ configRoot: "/tmp/root" });

    expect(syncSkillsCacheMock).toHaveBeenCalledWith(expect.anything(), "/tmp/root");
    expect(workspaceCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ skillsSourceDir: "/home/u/.beevibe/skills" }),
    );
  });

  it("continues with /dev/null skills when the sync fails", async () => {
    loadConfigMock.mockReturnValue(config());
    syncSkillsCacheMock.mockRejectedValue(new Error("403 from api"));

    await startAndSettle();

    expect(warnMock).toHaveBeenCalledWith(
      "[daemon] skills sync failed; continuing without skills:",
      "403 from api",
    );
    expect(workspaceCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ skillsSourceDir: "/dev/null" }),
    );
    // A failed sync must not stop the claimer from coming up.
    expect(claimerStartMock).toHaveBeenCalledOnce();
  });

  it("stringifies a non-Error skills-sync rejection", async () => {
    loadConfigMock.mockReturnValue(config());
    syncSkillsCacheMock.mockRejectedValue("plain string boom");

    await startAndSettle();

    expect(warnMock).toHaveBeenCalledWith(
      "[daemon] skills sync failed; continuing without skills:",
      "plain string boom",
    );
  });

  it("falls back to /dev/null when the sync resolves undefined", async () => {
    loadConfigMock.mockReturnValue(config());
    syncSkillsCacheMock.mockResolvedValue(undefined);

    await startAndSettle();

    expect(workspaceCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ skillsSourceDir: "/dev/null" }),
    );
  });

  it("defaults the workspace root under the config root", async () => {
    loadConfigMock.mockReturnValue(config());
    getConfigRootMock.mockReturnValue("/home/u/.beevibe");

    await startAndSettle();

    expect(workspaceCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServerUrl: "http://api.test/mcp",
        workspaceRoot: "/home/u/.beevibe/workspaces",
        runtimeRegistry: { registry: true },
      }),
    );
  });

  it("lets a non-empty WORKSPACE_ROOT env win", async () => {
    loadConfigMock.mockReturnValue(config());
    process.env.WORKSPACE_ROOT = "/ci/workspaces";

    await startAndSettle();

    expect(workspaceCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: "/ci/workspaces" }),
    );
  });

  it("ignores an empty WORKSPACE_ROOT env", async () => {
    loadConfigMock.mockReturnValue(config());
    process.env.WORKSPACE_ROOT = "";

    await startAndSettle();

    expect(workspaceCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: "/home/u/.beevibe/workspaces" }),
    );
  });

  it("gives the claimer every configured runtime id and starts it", async () => {
    loadConfigMock.mockReturnValue(config());

    await startAndSettle();

    expect(supervisorCtorMock).toHaveBeenCalledOnce();
    expect(claimerCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeIds: ["rt_1", "rt_2"] }),
    );
    expect(claimerStartMock).toHaveBeenCalledOnce();
  });

  it("logs the daemon id, api url and runtime count once started", async () => {
    loadConfigMock.mockReturnValue(config());

    await startAndSettle();

    expect(logMock).toHaveBeenCalledWith(
      "[daemon] started (dmn_1 → http://api.test, 2 runtime(s))",
    );
  });
});

describe("runStart — shutdown and resilience", () => {
  it("stops the claimer and exits on SIGINT", async () => {
    loadConfigMock.mockReturnValue(config());
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await startAndSettle();
    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 0));

    expect(logMock).toHaveBeenCalledWith("[daemon] received SIGINT; stopping");
    expect(claimerStopMock).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("stops the claimer and exits on SIGTERM", async () => {
    loadConfigMock.mockReturnValue(config());
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await startAndSettle();
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 0));

    expect(logMock).toHaveBeenCalledWith("[daemon] received SIGTERM; stopping");
    expect(claimerStopMock).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent across repeated signals", async () => {
    loadConfigMock.mockReturnValue(config());
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await startAndSettle();
    process.emit("SIGINT");
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 0));

    // The `stopped` latch means the second signal is a no-op.
    expect(claimerStopMock).toHaveBeenCalledOnce();
  });

  it("logs and survives an unhandled rejection", async () => {
    loadConfigMock.mockReturnValue(config());

    await startAndSettle();
    process.emit("unhandledRejection", new Error("leaked fetch"), Promise.resolve());

    expect(warnMock).toHaveBeenCalledWith(
      "[daemon] unhandledRejection (continuing):",
      "leaked fetch",
    );
  });

  it("stringifies a non-Error unhandled rejection", async () => {
    loadConfigMock.mockReturnValue(config());

    await startAndSettle();
    process.emit("unhandledRejection", "bare reason", Promise.resolve());

    expect(warnMock).toHaveBeenCalledWith(
      "[daemon] unhandledRejection (continuing):",
      "bare reason",
    );
  });

  it("never settles while running", async () => {
    loadConfigMock.mockReturnValue(config());
    const sentinel = Symbol("pending");

    const race = await Promise.race([
      runStart().then(() => "settled"),
      new Promise((r) => setTimeout(() => r(sentinel), 20)),
    ]);

    expect(race).toBe(sentinel);
  });
});
