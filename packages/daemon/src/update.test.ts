import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUpdate } from "./update.js";

const { renameSyncMock, chmodSyncMock, logMock, errorMock, questionMock } = vi.hoisted(
  () => ({
    renameSyncMock: vi.fn(),
    chmodSyncMock: vi.fn(),
    logMock: vi.fn(),
    errorMock: vi.fn(),
    questionMock: vi.fn(),
  }),
);

// Only the two mutating calls are faked: staging still happens in a real
// temp dir so the streamed download + hash path is exercised for real.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: renameSyncMock, chmodSync: chmodSyncMock };
});
vi.mock("./logger.js", () => ({ log: logMock, warn: vi.fn(), error: errorMock }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: questionMock, close: vi.fn() }),
}));

const RELEASES_API_URL =
  "https://api.github.com/repos/beevibe-ai/beevibe/releases/latest";
const ASSET = "beevibe-daemon-linux-x64";
const BINARY = "#!/fake compiled daemon binary\n";
const BINARY_SHA = createHash("sha256").update(BINARY).digest("hex");

class ProcessExit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/** Serve the release manifest, the asset stream and its .sha256 companion. */
function stubGithub(opts: {
  release?: { status?: number; tag?: string } | null;
  binary?: string;
  checksum?: string;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === RELEASES_API_URL) {
      const status = opts.release?.status ?? 200;
      if (status !== 200) {
        return { status, ok: false, text: async () => "boom" };
      }
      return {
        status,
        ok: true,
        json: async () => ({ tag_name: opts.release?.tag ?? "v9.9.9", assets: [] }),
      };
    }
    if (url.endsWith(".sha256")) {
      return {
        status: 200,
        ok: true,
        text: async () => `${opts.checksum ?? BINARY_SHA}  ${ASSET}`,
      };
    }
    return { status: 200, ok: true, body: new Response(opts.binary ?? BINARY).body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Present the process as a Bun-compiled standalone binary. */
function asCompiledBinary(): void {
  (process.versions as { bun?: string }).bun = "1.1.0";
  Object.defineProperty(process, "execPath", {
    value: "/usr/local/bin/beevibe-daemon",
    configurable: true,
    writable: true,
  });
}

const g = globalThis as Record<string, unknown>;
let realExecPath: string;

beforeEach(() => {
  realExecPath = process.execPath;
  g.BEEVIBE_DAEMON_VERSION = "1.0.0";
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ProcessExit(code);
  }) as never);
});

afterEach(() => {
  delete g.BEEVIBE_DAEMON_VERSION;
  delete (process.versions as { bun?: string }).bun;
  Object.defineProperty(process, "execPath", {
    value: realExecPath,
    configurable: true,
    writable: true,
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  renameSyncMock.mockReset();
  chmodSyncMock.mockReset();
  logMock.mockReset();
  errorMock.mockReset();
  questionMock.mockReset();
});

/** Everything passed to the mocked logger, flattened for substring matching. */
function logged(mock: typeof logMock): string {
  return mock.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

describe("runUpdate install-method guards", () => {
  it("exits 2 with per-install-method hints when the version was never baked in", async () => {
    delete g.BEEVIBE_DAEMON_VERSION;
    const fetchMock = stubGithub({});

    await expect(runUpdate({ skipPrompt: true })).rejects.toBeInstanceOf(ProcessExit);
    expect(logged(logMock)).toMatch(/npm update -g @beevibe\/daemon/);
    expect(logged(logMock)).toMatch(/git pull/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bails with hints, not an error, when not running as a compiled binary", async () => {
    const fetchMock = stubGithub({});

    await expect(runUpdate({ skipPrompt: true })).resolves.toBeUndefined();

    expect(logged(logMock)).toMatch(/not produced by the standalone build path/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats `bun src/main.ts` as a source run, not a compiled binary", async () => {
    (process.versions as { bun?: string }).bun = "1.1.0";
    Object.defineProperty(process, "execPath", {
      value: "/home/dev/.bun/bin/bun",
      configurable: true,
      writable: true,
    });
    const fetchMock = stubGithub({});

    await runUpdate({ skipPrompt: true });

    expect(logged(logMock)).toMatch(/not produced by the standalone build path/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exits 2 on a platform with no published binary", async () => {
    asCompiledBinary();
    Object.defineProperty(process, "platform", { value: "sunos", configurable: true });
    stubGithub({});

    try {
      await expect(runUpdate({ skipPrompt: true })).rejects.toBeInstanceOf(ProcessExit);
      expect(errorMock.mock.calls.flat().join("\n")).toMatch(/Unsupported platform/);
    } finally {
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });
    }
  });
});

describe("runUpdate version comparison", () => {
  beforeEach(asCompiledBinary);

  it("stops when GitHub has no releases yet", async () => {
    stubGithub({ release: { status: 404 } });

    await expect(runUpdate({ skipPrompt: true })).resolves.toBeUndefined();
    expect(logged(logMock)).toMatch(/No releases published yet/);
    expect(renameSyncMock).not.toHaveBeenCalled();
  });

  it("surfaces a non-404 GitHub API failure", async () => {
    stubGithub({ release: { status: 503 } });

    await expect(runUpdate({ skipPrompt: true })).rejects.toThrow(
      /GitHub API returned 503/,
    );
  });

  it.each([
    { latest: "v1.0.0", why: "identical" },
    { latest: "v0.9.9", why: "older patch" },
    { latest: "v0.11.0", why: "older minor despite the higher digit" },
  ])("stays put when the latest release is $why ($latest)", async ({ latest }) => {
    stubGithub({ release: { tag: latest } });

    await runUpdate({ skipPrompt: true });

    expect(logged(logMock)).toMatch(/Already on the latest version/);
    expect(renameSyncMock).not.toHaveBeenCalled();
  });

  it.each(["v1.0.1", "v1.1.0", "v2.0.0"])(
    "updates when the latest release is %s",
    async (latest) => {
      stubGithub({ release: { tag: latest } });

      await runUpdate({ skipPrompt: true });

      expect(renameSyncMock).toHaveBeenCalledTimes(1);
      expect(logged(logMock)).toMatch(new RegExp(`Updated to ${latest}`));
    },
  );
});

describe("runUpdate install", () => {
  beforeEach(asCompiledBinary);

  it("verifies the checksum, chmods 0755 and renames over the running binary", async () => {
    stubGithub({ release: { tag: "v2.0.0" } });
    // The staging dir is removed in a finally block, so read it while
    // the install is still in flight.
    let staged: { path: string; mode: number; content: string } | undefined;
    chmodSyncMock.mockImplementation((path: string, mode: number) => {
      staged = { path, mode, content: readFileSync(path, "utf8") };
    });

    await runUpdate({ skipPrompt: true });

    expect(staged?.mode).toBe(0o755);
    expect(staged?.content).toBe(BINARY);
    expect(renameSyncMock).toHaveBeenCalledWith(
      staged?.path,
      "/usr/local/bin/beevibe-daemon",
    );
  });

  it("exits 3 without installing when the downloaded bytes do not match the checksum", async () => {
    stubGithub({ release: { tag: "v2.0.0" }, checksum: "a".repeat(64) });

    await expect(runUpdate({ skipPrompt: true })).rejects.toBeInstanceOf(ProcessExit);

    expect(renameSyncMock).not.toHaveBeenCalled();
    expect(errorMock.mock.calls.flat().join("\n")).toMatch(/Checksum mismatch/);
  });

  it("rejects a checksum file that is not 64 hex characters", async () => {
    stubGithub({ release: { tag: "v2.0.0" }, checksum: "not-a-sha" });

    await expect(runUpdate({ skipPrompt: true })).rejects.toThrow(
      /bad checksum format/,
    );
    expect(renameSyncMock).not.toHaveBeenCalled();
  });

  it("leaves the staged binary in place and returns when the rename fails", async () => {
    stubGithub({ release: { tag: "v2.0.0" } });
    renameSyncMock.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    await expect(runUpdate({ skipPrompt: true })).resolves.toBeUndefined();

    const errors = errorMock.mock.calls.flat().join("\n");
    expect(errors).toMatch(/EACCES: permission denied/);
    expect(errors).toMatch(/install manually if needed/);
  });

  it("asks before installing and honours a refusal", async () => {
    stubGithub({ release: { tag: "v2.0.0" } });
    questionMock.mockResolvedValue("n");

    await runUpdate();

    expect(questionMock).toHaveBeenCalledWith(
      expect.stringContaining("Install this update now?"),
    );
    expect(renameSyncMock).not.toHaveBeenCalled();
    expect(logged(logMock)).toMatch(/Update cancelled/);
  });

  it.each(["y", "Y", "yes", " yes "])("installs on a %j answer", async (answer) => {
    stubGithub({ release: { tag: "v2.0.0" } });
    questionMock.mockResolvedValue(answer);

    await runUpdate();

    expect(renameSyncMock).toHaveBeenCalledTimes(1);
  });

  it.each(["", "no", "later"])("does not install on a %j answer", async (answer) => {
    stubGithub({ release: { tag: "v2.0.0" } });
    questionMock.mockResolvedValue(answer);

    await runUpdate();

    expect(renameSyncMock).not.toHaveBeenCalled();
  });
});
