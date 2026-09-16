/**
 * `beevibe-daemon` CLI entry — flag parsing, command dispatch, and the
 * dev-only `--config-root` gate. None of it was covered: `main.ts` runs
 * `main()` as an import side effect, so the tests drive it the same way
 * the shell does — set `process.argv`, re-import the module, assert on
 * the mocked subcommands.
 *
 * `process.exit` is stubbed to record rather than terminate, so the
 * assertions are "exited with code N", not "stopped here". Execution
 * continues past the stub; every subcommand is mocked, so nothing
 * escapes.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const {
  errorMock,
  isDevBuildMock,
  logMock,
  runSetupMock,
  runStartMock,
  runSyncMock,
  runUpdateMock,
} = vi.hoisted(() => ({
  errorMock: vi.fn(),
  isDevBuildMock: vi.fn(() => true),
  logMock: vi.fn(),
  runSetupMock: vi.fn(),
  runStartMock: vi.fn(),
  runSyncMock: vi.fn(),
  runUpdateMock: vi.fn(),
}));

vi.mock("./logger.js", () => ({ log: logMock, warn: vi.fn(), error: errorMock }));
vi.mock("./setup.js", () => ({ runSetup: runSetupMock }));
vi.mock("./start.js", () => ({ runStart: runStartMock }));
vi.mock("./sync.js", () => ({ runSync: runSyncMock }));
vi.mock("./update.js", () => ({ runUpdate: runUpdateMock }));

// Real config module except for the build-flavour probe: `isDevBuild()`
// is compile-time `true` under vitest, so the compiled-prod rejection
// branch is only reachable with it stubbed.
vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  isDevBuild: isDevBuildMock,
}));

const originalArgv = process.argv;
let exitSpy: MockInstance<typeof process.exit>;

/** Run the CLI as the shell would, and wait for `main()` to settle. */
async function runCli(...args: string[]): Promise<void> {
  vi.resetModules();
  process.argv = ["node", "/usr/local/bin/beevibe-daemon", ...args];
  await import("./main.js");
  // main() is fired as an import side effect and its promise isn't
  // exported — drain the queue so its awaits have run.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** Every line printed via `log`, joined — `printHelp` emits one call. */
function printed(): string {
  return logMock.mock.calls.map((call) => call.join(" ")).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  isDevBuildMock.mockReturnValue(true);
  runSetupMock.mockResolvedValue({
    daemon_id: "dmn_1",
    runtimes: [{ id: "rt_claude", cli: "claude" }],
  });
  runStartMock.mockResolvedValue(undefined);
  runSyncMock.mockResolvedValue({ added: [] });
  runUpdateMock.mockResolvedValue(undefined);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  delete process.env.BEEVIBE_CONFIG_ROOT;
});

afterEach(() => {
  process.argv = originalArgv;
  exitSpy.mockRestore();
  delete process.env.BEEVIBE_CONFIG_ROOT;
});

describe("help", () => {
  it.each([[], ["--help"], ["-h"]])(
    "prints usage for %j without running a subcommand",
    async (...args) => {
      await runCli(...(args as string[]));

      expect(printed()).toContain("Usage: beevibe-daemon <command> [flags]");
      expect(runStartMock).not.toHaveBeenCalled();
      expect(runSetupMock).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    },
  );

  it("documents all four subcommands", async () => {
    await runCli("--help");

    const help = printed();
    for (const command of ["setup", "start", "sync", "update"]) {
      expect(help).toMatch(new RegExp(`^\\s+${command}\\s`, "m"));
    }
  });
});

describe("setup", () => {
  it("forwards every long flag to runSetup and reports the registration", async () => {
    await runCli(
      "setup",
      "--api",
      "http://api.test",
      "--user-token",
      "bv_u_abc",
      "--device-name",
      "Zhe's laptop",
      "--external-id",
      "machine-7",
    );

    expect(runSetupMock).toHaveBeenCalledWith({
      apiUrl: "http://api.test",
      userToken: "bv_u_abc",
      deviceName: "Zhe's laptop",
      externalId: "machine-7",
      configRoot: undefined,
    });
    expect(printed()).toContain("Registered as dmn_1");
    expect(printed()).toContain("claude (rt_claude)");
  });

  it("accepts the -a / -t short flags", async () => {
    await runCli("setup", "-a", "http://api.test", "-t", "bv_u_abc");

    expect(runSetupMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: "http://api.test", userToken: "bv_u_abc" }),
    );
  });

  it("exits 2 when --api is missing", async () => {
    await runCli("setup", "--user-token", "bv_u_abc");

    expect(errorMock).toHaveBeenCalledWith("setup requires --api and --user-token");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("exits 2 when --user-token is missing", async () => {
    await runCli("setup", "--api", "http://api.test");

    expect(errorMock).toHaveBeenCalledWith("setup requires --api and --user-token");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("ignores a trailing flag with no value", async () => {
    // `--api` last with nothing after it must not swallow undefined.
    await runCli("setup", "--user-token", "bv_u_abc", "--api");

    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

describe("start", () => {
  it("runs with no config-root override by default", async () => {
    await runCli("start");

    expect(runStartMock).toHaveBeenCalledWith({ configRoot: undefined });
  });

  it("passes --config-root through on a dev build", async () => {
    await runCli("start", "--config-root", "/tmp/alt-root");

    expect(runStartMock).toHaveBeenCalledWith({ configRoot: "/tmp/alt-root" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("falls back to BEEVIBE_CONFIG_ROOT when the flag is absent", async () => {
    process.env.BEEVIBE_CONFIG_ROOT = "/tmp/env-root";

    await runCli("start");

    expect(runStartMock).toHaveBeenCalledWith({ configRoot: "/tmp/env-root" });
  });

  it("prefers the flag over the env var", async () => {
    process.env.BEEVIBE_CONFIG_ROOT = "/tmp/env-root";

    await runCli("start", "--config-root", "/tmp/flag-root");

    expect(runStartMock).toHaveBeenCalledWith({ configRoot: "/tmp/flag-root" });
  });

  it("treats an empty BEEVIBE_CONFIG_ROOT as unset", async () => {
    process.env.BEEVIBE_CONFIG_ROOT = "";

    await runCli("start");

    expect(runStartMock).toHaveBeenCalledWith({ configRoot: undefined });
  });
});

describe("config-root gate on compiled builds", () => {
  it("rejects --config-root with exit 2, naming the flag", async () => {
    isDevBuildMock.mockReturnValue(false);

    await runCli("start", "--config-root", "/tmp/alt-root");

    expect(errorMock).toHaveBeenCalledWith(
      expect.stringContaining("--config-root is a dev-only knob"),
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("rejects the env var with exit 2, naming the env var", async () => {
    isDevBuildMock.mockReturnValue(false);
    process.env.BEEVIBE_CONFIG_ROOT = "/tmp/env-root";

    await runCli("start");

    expect(errorMock).toHaveBeenCalledWith(
      expect.stringContaining("BEEVIBE_CONFIG_ROOT is a dev-only knob"),
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("stays quiet on a compiled build when neither knob is set", async () => {
    isDevBuildMock.mockReturnValue(false);

    await runCli("start");

    expect(errorMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(runStartMock).toHaveBeenCalledWith({ configRoot: undefined });
  });
});

describe("sync", () => {
  it("says so when nothing new is on PATH", async () => {
    runSyncMock.mockResolvedValue({ added: [] });

    await runCli("sync");

    expect(runSyncMock).toHaveBeenCalledWith({ configRoot: undefined });
    expect(printed()).toContain("No new CLIs detected.");
  });

  it("lists the runtimes it added and asks for a restart", async () => {
    runSyncMock.mockResolvedValue({
      added: [
        { id: "rt_codex", cli: "codex" },
        { id: "rt_opencode", cli: "opencode" },
      ],
    });

    await runCli("sync");

    expect(printed()).toContain("Added 2 runtime(s): codex (rt_codex), opencode (rt_opencode).");
    expect(printed()).toContain("Restart the daemon");
  });
});

describe("update", () => {
  it("prompts by default", async () => {
    await runCli("update");

    expect(runUpdateMock).toHaveBeenCalledWith({ skipPrompt: false });
  });

  it.each(["--yes", "-y"])("skips the prompt with %s", async (flag) => {
    await runCli("update", flag);

    expect(runUpdateMock).toHaveBeenCalledWith({ skipPrompt: true });
  });
});

describe("failure paths", () => {
  it("exits 2 on an unknown command, after printing help", async () => {
    await runCli("frobnicate");

    expect(errorMock).toHaveBeenCalledWith("Unknown command: frobnicate");
    expect(printed()).toContain("Usage: beevibe-daemon");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("exits 1 with the stack when a subcommand throws", async () => {
    const boom = new Error("api unreachable");
    boom.stack = "Error: api unreachable\n    at somewhere";
    runStartMock.mockRejectedValue(boom);

    await runCli("start");

    expect(errorMock).toHaveBeenCalledWith(boom.stack);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 with the message when the thrown error has no stack", async () => {
    const boom = new Error("api unreachable");
    boom.stack = undefined;
    runStartMock.mockRejectedValue(boom);

    await runCli("start");

    expect(errorMock).toHaveBeenCalledWith("api unreachable");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 stringifying a non-Error rejection", async () => {
    runStartMock.mockRejectedValue("plain string failure");

    await runCli("start");

    expect(errorMock).toHaveBeenCalledWith("plain string failure");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
