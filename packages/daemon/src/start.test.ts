/**
 * `beevibe-daemon start` — wiring tests.
 *
 * `runStart` never resolves by design (it parks on a forever-promise to
 * hold the process open), so these tests fire it without awaiting and
 * assert on what it wired up by the time the microtask queue drains.
 * Every collaborator is mocked; nothing opens a socket or touches disk.
 *
 * The behaviour worth pinning is the part that isn't just construction:
 * the missing-config guard, skills-sync being non-fatal, the
 * WORKSPACE_ROOT precedence, and the signal / unhandledRejection
 * handlers whose absence would either wedge or kill a live daemon.
 */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStart } from "./start.js";

const {
  loadConfigMock,
  getConfigRootMock,
  syncSkillsCacheMock,
  apiClientMock,
  workspaceManagerMock,
  supervisorMock,
  claimerMock,
  claimerStart,
  claimerStop,
  runtimeRegistryMock,
  logMock,
  warnMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  getConfigRootMock: vi.fn(),
  syncSkillsCacheMock: vi.fn(),
  apiClientMock: vi.fn(),
  workspaceManagerMock: vi.fn(),
  supervisorMock: vi.fn(),
  claimerMock: vi.fn(),
  claimerStart: vi.fn(),
  claimerStop: vi.fn(),
  runtimeRegistryMock: vi.fn(),
  logMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock("./config.js", () => ({
  loadConfig: loadConfigMock,
  getConfigRoot: getConfigRootMock,
}));
vi.mock("./skills-cache.js", () => ({ syncSkillsCache: syncSkillsCacheMock }));
vi.mock("./logger.js", () => ({ log: logMock, warn: warnMock }));
vi.mock("./api-client.js", () => ({
  ApiClient: class {
    constructor(...args: unknown[]) {
      apiClientMock(...args);
    }
  },
}));
vi.mock("./supervisor.js", () => ({
  Supervisor: class {
    constructor(...args: unknown[]) {
      supervisorMock(...args);
    }
  },
}));
vi.mock("./claimer.js", () => ({
  Claimer: class {
    start = claimerStart;
    stop = claimerStop;
    constructor(...args: unknown[]) {
      claimerMock(...args);
    }
  },
}));
vi.mock("@beevibe/core/adapters/local-workspace", () => ({
  LocalWorkspaceManager: class {
    constructor(...args: unknown[]) {
      workspaceManagerMock(...args);
    }
  },
}));
vi.mock("@beevibe/core/adapters/runtime-registry", () => ({
  createDefaultRuntimeRegistry: runtimeRegistryMock,
}));

const CONFIG = {
  api_url: "http://api.test",
  external_id: "ext_1",
  daemon_id: "dmn_1",
  daemon_token: "bv_d_secret",
  runtimes: [
    { id: "rt_claude", cli: "claude" },
    { id: "rt_codex", cli: "codex" },
  ],
};

const SIGNALS = ["SIGINT", "SIGTERM", "unhandledRejection"] as const;
type Signal = (typeof SIGNALS)[number];
type Listener = (arg?: unknown) => void;

/**
 * `process.listeners` is typed per-event; these two erase the overload
 * so one loop can cover both the signals and `unhandledRejection`.
 */
const listenersOf = (signal: Signal): Listener[] =>
  (process.listeners as unknown as (e: string) => Listener[])(signal);
const removeListener = (signal: Signal, listener: Listener): void => {
  (process.removeListener as unknown as (e: string, l: Listener) => void)(
    signal,
    listener,
  );
};

/** Listeners already on the process, so tests only clean up their own. */
let preexisting: Record<Signal, Listener[]>;

/**
 * Fire `runStart` without awaiting it (it never settles) and let the
 * awaits inside it drain.
 */
async function start(options: { configRoot?: string } = {}): Promise<void> {
  void runStart(options).catch(() => undefined);
  await vi.waitFor(() => expect(claimerStart).toHaveBeenCalled());
}

/** The handler `runStart` registered for `signal`, if any. */
function addedListener(signal: Signal): Listener | undefined {
  return listenersOf(signal).find((l) => !preexisting[signal].includes(l));
}

/** First constructor/call argument of a mock, as a readable options bag. */
function firstArg(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return (mock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  loadConfigMock.mockReturnValue(CONFIG);
  getConfigRootMock.mockReturnValue("/home/tester/.beevibe");
  syncSkillsCacheMock.mockResolvedValue("/home/tester/.beevibe/skills");
  runtimeRegistryMock.mockReturnValue({ registry: true });
  delete process.env.WORKSPACE_ROOT;

  preexisting = {
    SIGINT: listenersOf("SIGINT"),
    SIGTERM: listenersOf("SIGTERM"),
    unhandledRejection: listenersOf("unhandledRejection"),
  };
});

afterEach(() => {
  for (const signal of SIGNALS) {
    for (const listener of listenersOf(signal)) {
      if (!preexisting[signal].includes(listener)) {
        removeListener(signal, listener);
      }
    }
  }
  delete process.env.WORKSPACE_ROOT;
});

describe("runStart — config guard", () => {
  it("tells the operator to run setup when no config exists", async () => {
    loadConfigMock.mockReturnValue(undefined);
    await expect(runStart()).rejects.toThrow(/beevibe-daemon setup/);
    expect(claimerStart).not.toHaveBeenCalled();
  });

  it("passes the config-root override through to loadConfig", async () => {
    loadConfigMock.mockReturnValue(undefined);
    await expect(runStart({ configRoot: "/tmp/alt" })).rejects.toThrow();
    expect(loadConfigMock).toHaveBeenCalledWith("/tmp/alt");
  });
});

describe("runStart — wiring", () => {
  it("builds the api client from the persisted url and token", async () => {
    await start();
    expect(apiClientMock).toHaveBeenCalledWith({
      apiUrl: "http://api.test",
      daemonToken: "bv_d_secret",
    });
  });

  it("points the workspace manager at the api's /mcp endpoint", async () => {
    await start();
    expect(firstArg(workspaceManagerMock)).toMatchObject({
      mcpServerUrl: "http://api.test/mcp",
      skillsSourceDir: "/home/tester/.beevibe/skills",
      runtimeRegistry: { registry: true },
    });
  });

  it("subscribes the claimer to every registered runtime id", async () => {
    await start();
    expect(firstArg(claimerMock)).toMatchObject({
      runtimeIds: ["rt_claude", "rt_codex"],
    });
    expect(claimerStart).toHaveBeenCalledTimes(1);
  });

  it("logs the daemon id, api url and runtime count once started", async () => {
    await start();
    expect(logMock).toHaveBeenCalledWith(
      "[daemon] started (dmn_1 → http://api.test, 2 runtime(s))",
    );
  });
});

describe("runStart — workspace root precedence", () => {
  it("defaults to <configRoot>/workspaces", async () => {
    getConfigRootMock.mockReturnValue("/tmp/alt-root");
    await start({ configRoot: "/tmp/alt-root" });
    expect(getConfigRootMock).toHaveBeenCalledWith("/tmp/alt-root");
    expect(firstArg(workspaceManagerMock).workspaceRoot).toBe(
      join("/tmp/alt-root", "workspaces"),
    );
  });

  it("lets WORKSPACE_ROOT win", async () => {
    process.env.WORKSPACE_ROOT = "/ci/workspaces";
    await start();
    expect(firstArg(workspaceManagerMock).workspaceRoot).toBe(
      "/ci/workspaces",
    );
  });

  it("treats an empty WORKSPACE_ROOT as unset", async () => {
    // Guards against a `WORKSPACE_ROOT=` line leaking out of a .env.
    process.env.WORKSPACE_ROOT = "";
    await start();
    expect(firstArg(workspaceManagerMock).workspaceRoot).toBe(
      join("/home/tester/.beevibe", "workspaces"),
    );
  });
});

describe("runStart — skills sync is best-effort", () => {
  it("syncs against the same config root", async () => {
    await start({ configRoot: "/tmp/alt-root" });
    expect(syncSkillsCacheMock).toHaveBeenCalledWith(
      expect.anything(),
      "/tmp/alt-root",
    );
  });

  it("keeps starting when the sync fails, with a /dev/null skills dir", async () => {
    syncSkillsCacheMock.mockRejectedValue(new Error("registry 503"));
    await start();
    expect(warnMock).toHaveBeenCalledWith(
      "[daemon] skills sync failed; continuing without skills:",
      "registry 503",
    );
    expect(firstArg(workspaceManagerMock).skillsSourceDir).toBe(
      "/dev/null",
    );
    expect(claimerStart).toHaveBeenCalled();
  });

  it("stringifies a non-Error sync rejection", async () => {
    syncSkillsCacheMock.mockRejectedValue("offline");
    await start();
    expect(warnMock).toHaveBeenCalledWith(
      "[daemon] skills sync failed; continuing without skills:",
      "offline",
    );
  });
});

describe("runStart — process handlers", () => {
  it("stops the claimer and exits on SIGINT", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    await start();

    addedListener("SIGINT")?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(logMock).toHaveBeenCalledWith("[daemon] received SIGINT; stopping");
    expect(claimerStop).toHaveBeenCalledTimes(1);
    exit.mockRestore();
  });

  it("ignores a second signal while the first stop is in flight", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    await start();

    const onTerm = addedListener("SIGTERM");
    onTerm?.();
    onTerm?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(claimerStop).toHaveBeenCalledTimes(1);
    exit.mockRestore();
  });

  it("logs and continues on an unhandled rejection rather than dying", async () => {
    await start();
    const onRejection = addedListener("unhandledRejection");
    expect(onRejection).toBeDefined();

    onRejection?.(new Error("fetch aborted"));
    expect(warnMock).toHaveBeenCalledWith(
      "[daemon] unhandledRejection (continuing):",
      "fetch aborted",
    );

    onRejection?.("plain string");
    expect(warnMock).toHaveBeenCalledWith(
      "[daemon] unhandledRejection (continuing):",
      "plain string",
    );
  });
});
