/**
 * `runStart` — the daemon's startup path. Collaborators (Claimer, the
 * workspace manager, skills sync) are mocked; what's pinned here is what
 * runStart decides: refuse to run unconfigured, survive a skills-sync
 * failure, pick the right workspace root, pass the configured runtime ids
 * to the claimer, and wire the signal + unhandled-rejection handlers.
 *
 * `runStart` deliberately never resolves (it holds the process open), so
 * every test here starts it without awaiting and then drives the mocks.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig, type DaemonConfig } from "./config.js";

const claimerStart = vi.fn();
const claimerStop = vi.fn(async () => {});
const claimerCtor = vi.fn();
const workspaceCtor = vi.fn();
const syncSkillsCache = vi.fn(async () => "/skills/cache");

vi.mock("./claimer.js", () => ({
  Claimer: class {
    constructor(cfg: unknown) {
      claimerCtor(cfg);
    }
    start = claimerStart;
    stop = claimerStop;
  },
}));

vi.mock("./supervisor.js", () => ({
  Supervisor: class {},
}));

vi.mock("./api-client.js", () => ({
  ApiClient: class {
    constructor(public readonly cfg: unknown) {}
  },
}));

vi.mock("./skills-cache.js", () => ({
  syncSkillsCache: (...args: unknown[]) => syncSkillsCache(...(args as [])),
}));

vi.mock("@beevibe/core/adapters/local-workspace", () => ({
  LocalWorkspaceManager: class {
    constructor(cfg: unknown) {
      workspaceCtor(cfg);
    }
  },
}));

vi.mock("@beevibe/core/adapters/runtime-registry", () => ({
  createDefaultRuntimeRegistry: () => ({ fake: "registry" }),
}));

// Imported after the mocks so the module under test picks them up.
const { runStart } = await import("./start.js");

function sampleConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    api_url: "http://localhost:3000",
    external_id: "host.test",
    daemon_id: "dmn_test",
    daemon_token: "bv_d_test",
    runtimes: [
      { id: "rt_claude", cli: "claude" },
      { id: "rt_codex", cli: "codex" },
    ],
    ...overrides,
  };
}

let configRoot: string;
let originalWorkspaceRoot: string | undefined;
/** Signal/rejection handlers runStart attaches, so tests can un-attach them. */
type ProcessHandler = (...args: never[]) => void;
let attached: Array<[string, ProcessHandler]>;

beforeEach(() => {
  vi.clearAllMocks();
  syncSkillsCache.mockResolvedValue("/skills/cache");
  configRoot = mkdtempSync(join(tmpdir(), "bv-start-"));
  originalWorkspaceRoot = process.env.WORKSPACE_ROOT;
  delete process.env.WORKSPACE_ROOT;

  attached = [];
  const realOn = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation(((event: string, handler: ProcessHandler) => {
    attached.push([event, handler]);
    return realOn(event as never, handler as never);
  }) as typeof process.on);
});

afterEach(() => {
  for (const [event, handler] of attached) {
    process.off(event, handler as (...args: unknown[]) => void);
  }
  vi.restoreAllMocks();
  rmSync(configRoot, { recursive: true, force: true });
  if (originalWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
  else process.env.WORKSPACE_ROOT = originalWorkspaceRoot;
});

/**
 * Kick off runStart and wait for its startup work to settle. The returned
 * promise is intentionally left pending — runStart holds the process open —
 * so attach a no-op catch to keep an unhandled rejection from leaking.
 */
async function startAndSettle(): Promise<void> {
  void runStart({ configRoot }).catch(() => {});
  // One macrotask is enough for the awaited skills sync + synchronous wiring.
  await new Promise((r) => setTimeout(r, 0));
}

describe("runStart — preconditions", () => {
  it("refuses to run with no config on disk and points at `setup`", async () => {
    await expect(runStart({ configRoot })).rejects.toThrow(/beevibe-daemon setup/);
    expect(claimerStart).not.toHaveBeenCalled();
  });
});

describe("runStart — wiring", () => {
  beforeEach(() => {
    saveConfig(sampleConfig(), configRoot);
  });

  it("starts the claimer with every configured runtime id", async () => {
    await startAndSettle();

    expect(claimerStart).toHaveBeenCalledOnce();
    expect(claimerCtor).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeIds: ["rt_claude", "rt_codex"] }),
    );
  });

  it("points the workspace manager at the config root's workspaces dir", async () => {
    await startAndSettle();

    expect(workspaceCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServerUrl: "http://localhost:3000/mcp",
        skillsSourceDir: "/skills/cache",
        workspaceRoot: join(configRoot, "workspaces"),
      }),
    );
  });

  it("lets WORKSPACE_ROOT override the config-root default", async () => {
    process.env.WORKSPACE_ROOT = "/ci/workspaces";
    await startAndSettle();

    expect(workspaceCtor).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: "/ci/workspaces" }),
    );
  });

  it("ignores an empty WORKSPACE_ROOT rather than binding to the repo root", async () => {
    process.env.WORKSPACE_ROOT = "";
    await startAndSettle();

    expect(workspaceCtor).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: join(configRoot, "workspaces") }),
    );
  });

  it("syncs skills before building the workspace manager", async () => {
    await startAndSettle();
    expect(syncSkillsCache).toHaveBeenCalledOnce();
  });

  it("starts anyway when the skills sync fails, with no skills dir", async () => {
    syncSkillsCache.mockRejectedValue(new Error("github unreachable"));
    await startAndSettle();

    expect(workspaceCtor).toHaveBeenCalledWith(
      expect.objectContaining({ skillsSourceDir: "/dev/null" }),
    );
    expect(claimerStart).toHaveBeenCalledOnce();
  });
});

describe("runStart — process handlers", () => {
  beforeEach(() => {
    saveConfig(sampleConfig(), configRoot);
  });

  it("stops the claimer once on SIGINT and exits 0", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await startAndSettle();

    const sigint = attached.find(([e]) => e === "SIGINT")?.[1];
    expect(sigint).toBeDefined();
    sigint!();
    sigint!(); // second signal must not re-enter the stop path
    await new Promise((r) => setTimeout(r, 0));

    expect(claimerStop).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("registers SIGTERM on the same stop path", async () => {
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await startAndSettle();

    const sigterm = attached.find(([e]) => e === "SIGTERM")?.[1];
    expect(sigterm).toBeDefined();
    sigterm!();
    await new Promise((r) => setTimeout(r, 0));
    expect(claimerStop).toHaveBeenCalledOnce();
  });

  it("logs an unhandled rejection and keeps the daemon up", async () => {
    await startAndSettle();

    const onRejection = attached.find(([e]) => e === "unhandledRejection")?.[1];
    expect(onRejection).toBeDefined();
    // The self-healing claimer loop is the reason this doesn't exit.
    expect(() =>
      (onRejection as unknown as (r: unknown) => void)(new Error("leaked")),
    ).not.toThrow();
    expect(claimerStop).not.toHaveBeenCalled();
  });
});
