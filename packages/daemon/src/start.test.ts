/**
 * `runStart` — the daemon's boot path. Nothing covered it: it is the one
 * function that turns a config file into a live claim loop, and every
 * wiring decision in it (which api url, which workspace root, what
 * happens when the skills bundle can't be fetched) is only observable
 * here.
 *
 * Collaborators are mocked at the module boundary; `./config.js` is real
 * and driven off a tmpdir config root, matching `sync.test.ts`.
 *
 * `runStart` deliberately never resolves — it awaits a forever-promise to
 * hold the process open. So the tests kick it off, wait for the wiring to
 * settle with `vi.waitFor`, and assert on the mocks. Only the
 * no-config case rejects, and that one is awaited normally.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig, type DaemonConfig } from "./config.js";
import { runStart } from "./start.js";

const {
  apiClientCtor,
  claimerCtor,
  claimerStart,
  claimerStop,
  registryCtor,
  syncSkillsCacheMock,
  warnMock,
  workspaceCtor,
} = vi.hoisted(() => ({
  apiClientCtor: vi.fn(),
  claimerCtor: vi.fn(),
  claimerStart: vi.fn(),
  claimerStop: vi.fn(async () => undefined),
  registryCtor: vi.fn(),
  syncSkillsCacheMock: vi.fn(),
  warnMock: vi.fn(),
  workspaceCtor: vi.fn(),
}));

vi.mock("./api-client.js", () => ({
  ApiClient: class {
    constructor(opts: unknown) {
      apiClientCtor(opts);
    }
  },
}));

vi.mock("./claimer.js", () => ({
  Claimer: class {
    start = claimerStart;
    stop = claimerStop;
    constructor(opts: unknown) {
      claimerCtor(opts);
    }
  },
}));

vi.mock("./skills-cache.js", () => ({ syncSkillsCache: syncSkillsCacheMock }));

vi.mock("@beevibe/core/adapters/local-workspace", () => ({
  LocalWorkspaceManager: class {
    constructor(opts: unknown) {
      workspaceCtor(opts);
    }
  },
}));

vi.mock("@beevibe/core/adapters/runtime-registry", () => ({
  createDefaultRuntimeRegistry: () => {
    registryCtor();
    return { __registry: true };
  },
}));

vi.mock("./logger.js", () => ({
  log: vi.fn(),
  warn: warnMock,
  error: vi.fn(),
}));

let root: string;
/** Signal listeners present before the test, so we can drop only ours. */
let preexistingListeners: Map<string, unknown[]>;
const SIGNALS = ["SIGINT", "SIGTERM", "unhandledRejection"] as const;

/**
 * `process.listeners` is typed per-overload (`Signals` vs. the named
 * process events), and this file iterates over a mix of both. Go through
 * the EventEmitter surface so one loop covers all three.
 */
const processEvents = process as NodeJS.EventEmitter;

function seedConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const config: DaemonConfig = {
    api_url: "http://api.test",
    external_id: "host.test",
    daemon_id: "dmn_1",
    daemon_token: "bv_d_secret",
    runtimes: [
      { id: "rt_claude", cli: "claude" },
      { id: "rt_codex", cli: "codex" },
    ],
    ...overrides,
  };
  saveConfig(config, root);
  return config;
}

/**
 * Kick off the never-resolving `runStart` and wait until the claim loop
 * is up. The floating promise is intentional — see the file header.
 */
async function startDaemon(): Promise<void> {
  void runStart({ configRoot: root });
  await vi.waitFor(() => expect(claimerStart).toHaveBeenCalled());
}

/** The handler `runStart` registered for `signal`, not vitest's own. */
function handlerFor(signal: (typeof SIGNALS)[number]): (...args: never[]) => void {
  const before = preexistingListeners.get(signal) ?? [];
  const added = processEvents.listeners(signal).filter((l) => !before.includes(l));
  expect(added).toHaveLength(1);
  return added[0] as (...args: never[]) => void;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "beevibe-start-test-"));
  preexistingListeners = new Map(SIGNALS.map((s) => [s, [...processEvents.listeners(s)]] as const));
  vi.clearAllMocks();
  syncSkillsCacheMock.mockResolvedValue("/cache/skills");
  delete process.env.WORKSPACE_ROOT;
});

afterEach(() => {
  // runStart attaches to the real process; leaving handlers behind would
  // leak across files (and MaxListeners-warn).
  for (const signal of SIGNALS) {
    const before = preexistingListeners.get(signal) ?? [];
    for (const listener of processEvents.listeners(signal)) {
      if (!before.includes(listener)) {
        processEvents.removeListener(signal, listener as () => void);
      }
    }
  }
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("runStart — preconditions", () => {
  it("refuses to run before setup, pointing at the setup command", async () => {
    await expect(runStart({ configRoot: root })).rejects.toThrow(
      /No daemon config found.*beevibe-daemon setup --api/s,
    );
  });

  it("does not build any collaborator when the config is missing", async () => {
    await expect(runStart({ configRoot: root })).rejects.toThrow();

    expect(apiClientCtor).not.toHaveBeenCalled();
    expect(claimerCtor).not.toHaveBeenCalled();
    expect(claimerStart).not.toHaveBeenCalled();
  });
});

describe("runStart — wiring", () => {
  it("points the ApiClient at the configured url with the daemon token", async () => {
    seedConfig();
    await startDaemon();

    expect(apiClientCtor).toHaveBeenCalledWith({
      apiUrl: "http://api.test",
      daemonToken: "bv_d_secret",
    });
  });

  it("derives the MCP server url from the api url", async () => {
    seedConfig({ api_url: "https://beevibe.example.com" });
    await startDaemon();

    expect(workspaceCtor.mock.calls[0]?.[0]).toMatchObject({
      mcpServerUrl: "https://beevibe.example.com/mcp",
    });
  });

  it("subscribes the claimer to every runtime id in the config", async () => {
    seedConfig();
    await startDaemon();

    expect(claimerCtor.mock.calls[0]?.[0]).toMatchObject({
      runtimeIds: ["rt_claude", "rt_codex"],
    });
    expect(claimerStart).toHaveBeenCalledTimes(1);
  });

  it("shares one runtime registry between the workspace manager and the claimer", async () => {
    seedConfig();
    await startDaemon();

    const registry = (workspaceCtor.mock.calls[0]?.[0] as { runtimeRegistry: unknown })
      .runtimeRegistry;
    expect(registry).toEqual({ __registry: true });
    expect(claimerCtor.mock.calls[0]?.[0]).toMatchObject({ runtimeRegistry: registry });
    expect(registryCtor).toHaveBeenCalledTimes(1);
  });
});

describe("runStart — skills cache", () => {
  it("passes the synced bundle directory to the workspace manager", async () => {
    seedConfig();
    syncSkillsCacheMock.mockResolvedValue("/cache/skills");
    await startDaemon();

    expect(syncSkillsCacheMock).toHaveBeenCalledWith(expect.anything(), root);
    expect(workspaceCtor.mock.calls[0]?.[0]).toMatchObject({
      skillsSourceDir: "/cache/skills",
    });
  });

  it("warns and keeps booting when the skills sync fails", async () => {
    seedConfig();
    syncSkillsCacheMock.mockRejectedValue(new Error("registry offline"));
    await startDaemon();

    // A failed bundle fetch must not be fatal — agents just run without
    // skills until the next boot.
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("skills sync failed"),
      "registry offline",
    );
    expect(workspaceCtor.mock.calls[0]?.[0]).toMatchObject({
      skillsSourceDir: "/dev/null",
    });
    expect(claimerStart).toHaveBeenCalledTimes(1);
  });

  it("falls back to /dev/null when the sync resolves without a directory", async () => {
    seedConfig();
    syncSkillsCacheMock.mockResolvedValue(undefined);
    await startDaemon();

    expect(workspaceCtor.mock.calls[0]?.[0]).toMatchObject({
      skillsSourceDir: "/dev/null",
    });
  });
});

describe("runStart — workspace root", () => {
  it("defaults workspaces under the config root so two daemons don't collide", async () => {
    seedConfig();
    await startDaemon();

    expect(workspaceCtor.mock.calls[0]?.[0]).toMatchObject({
      workspaceRoot: join(root, "workspaces"),
    });
  });

  it("lets WORKSPACE_ROOT win for CI and bespoke layouts", async () => {
    seedConfig();
    vi.stubEnv("WORKSPACE_ROOT", "/mnt/ci/workspaces");
    await startDaemon();

    expect(workspaceCtor.mock.calls[0]?.[0]).toMatchObject({
      workspaceRoot: "/mnt/ci/workspaces",
    });
  });

  it("treats an empty WORKSPACE_ROOT as unset", async () => {
    seedConfig();
    vi.stubEnv("WORKSPACE_ROOT", "");
    await startDaemon();

    expect(workspaceCtor.mock.calls[0]?.[0]).toMatchObject({
      workspaceRoot: join(root, "workspaces"),
    });
  });
});

describe("runStart — shutdown", () => {
  it("drains the claimer and exits 0 on SIGINT", async () => {
    seedConfig();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await startDaemon();

    await handlerFor("SIGINT")();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(claimerStop).toHaveBeenCalledTimes(1);
    exit.mockRestore();
  });

  it("drains the claimer and exits 0 on SIGTERM", async () => {
    seedConfig();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await startDaemon();

    await handlerFor("SIGTERM")();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(claimerStop).toHaveBeenCalledTimes(1);
    exit.mockRestore();
  });

  it("ignores a second signal while the first stop is in flight", async () => {
    seedConfig();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await startDaemon();

    const sigint = handlerFor("SIGINT");
    await sigint();
    await sigint();
    await handlerFor("SIGTERM")();

    // A double Ctrl-C must not run the drain twice.
    expect(claimerStop).toHaveBeenCalledTimes(1);
    exit.mockRestore();
  });

  it("logs and survives an unhandled rejection instead of taking the daemon down", async () => {
    seedConfig();
    await startDaemon();

    handlerFor("unhandledRejection")(new Error("leaked fetch") as never);

    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("unhandledRejection"),
      "leaked fetch",
    );
  });

  it("stringifies a non-Error rejection reason", async () => {
    seedConfig();
    await startDaemon();

    handlerFor("unhandledRejection")("just a string" as never);

    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("unhandledRejection"),
      "just a string",
    );
  });
});
