/**
 * `beevibe-daemon` CLI entry coverage.
 *
 * main.ts fires `main()` at import time, so each case re-imports the
 * module with a fresh `process.argv` after `vi.resetModules()`. The
 * module body doesn't await that call, so `runCli` drains the queue
 * before returning.
 *
 * `process.exit` is stubbed as a *recorder* rather than a thrower: a
 * throwing stub would escape main's own `.catch` (which itself calls
 * `process.exit`) as an unhandled rejection. The trade-off is that code
 * after an `exit()` still runs here, which the real CLI never does — so
 * assertions check the exit code and the operator-facing message, not
 * what the doomed continuation went on to do.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { CONFIG_ROOT_ENV } from "./config.js";

const {
  runSetupMock,
  runStartMock,
  runSyncMock,
  runUpdateMock,
  logMock,
  errorMock,
  isDevBuildMock,
} = vi.hoisted(() => ({
  runSetupMock: vi.fn(),
  runStartMock: vi.fn(),
  runSyncMock: vi.fn(),
  runUpdateMock: vi.fn(),
  logMock: vi.fn(),
  errorMock: vi.fn(),
  isDevBuildMock: vi.fn(),
}));

vi.mock("./setup.js", () => ({ runSetup: runSetupMock }));
vi.mock("./start.js", () => ({ runStart: runStartMock }));
vi.mock("./sync.js", () => ({ runSync: runSyncMock }));
vi.mock("./update.js", () => ({ runUpdate: runUpdateMock }));
vi.mock("./logger.js", () => ({
  log: logMock,
  warn: vi.fn(),
  error: errorMock,
}));
vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return { ...actual, isDevBuild: isDevBuildMock };
});

const REGISTERED = {
  daemon_id: "dmn_1",
  runtimes: [
    { id: "rt_claude", cli: "claude" },
    { id: "rt_codex", cli: "codex" },
  ],
};

let exitMock: MockInstance<typeof process.exit>;
let argv: string[];

/** Stub argv, re-import main.ts (which self-executes) and drain the queue. */
async function runCli(...args: string[]): Promise<void> {
  process.argv = ["node", "/usr/local/bin/beevibe-daemon", ...args];
  vi.resetModules();
  await import("./main.js");
  // Two macrotask turns: one for the awaited command, one for main's
  // trailing `.catch` to settle on the rejection paths.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** Everything the CLI printed, joined — help text is one multi-line call. */
function printed(): string {
  return logMock.mock.calls.map((call) => call.join(" ")).join("\n");
}

beforeEach(() => {
  argv = process.argv;
  delete process.env[CONFIG_ROOT_ENV];
  runSetupMock.mockReset().mockResolvedValue(REGISTERED);
  runStartMock.mockReset().mockResolvedValue(undefined);
  runSyncMock.mockReset().mockResolvedValue({ added: [] });
  runUpdateMock.mockReset().mockResolvedValue(undefined);
  logMock.mockReset();
  errorMock.mockReset();
  isDevBuildMock.mockReset().mockReturnValue(true);
  exitMock = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
});

afterEach(() => {
  process.argv = argv;
  delete process.env[CONFIG_ROOT_ENV];
  vi.restoreAllMocks();
});

describe("help", () => {
  it.each([[], ["--help"], ["-h"]])(
    "prints usage for %j without touching a command",
    async (...args) => {
      await runCli(...args);

      expect(printed()).toContain("Usage: beevibe-daemon <command> [flags]");
      expect(printed()).toContain("  setup    Register this machine");
      expect(exitMock).not.toHaveBeenCalled();
      expect(runStartMock).not.toHaveBeenCalled();
      expect(runSetupMock).not.toHaveBeenCalled();
    },
  );

  it("documents the dev-only config-root knob and its env var", async () => {
    await runCli("--help");

    expect(printed()).toContain("--config-root <path>");
    expect(printed()).toContain(CONFIG_ROOT_ENV);
  });

  it("rejects an unknown command with exit 2 and the usage block", async () => {
    await runCli("strat");

    expect(errorMock).toHaveBeenCalledWith("Unknown command: strat");
    expect(printed()).toContain("Usage: beevibe-daemon <command> [flags]");
    expect(exitMock).toHaveBeenCalledWith(2);
  });
});

describe("setup", () => {
  it("forwards every long flag and reports where the config landed", async () => {
    await runCli(
      "setup",
      "--api",
      "http://api.test",
      "--user-token",
      "bv_u_human",
      "--device-name",
      "workbench",
      "--external-id",
      "machine-7",
      "--config-root",
      "/tmp/root-a",
    );

    expect(runSetupMock).toHaveBeenCalledWith({
      apiUrl: "http://api.test",
      userToken: "bv_u_human",
      deviceName: "workbench",
      externalId: "machine-7",
      configRoot: "/tmp/root-a",
    });
    expect(printed()).toContain("Registered as dmn_1");
    expect(printed()).toContain("Runtimes: claude (rt_claude), codex (rt_codex)");
    expect(printed()).toContain(
      `Config saved to ${join("/tmp/root-a", "config.json")}`,
    );
  });

  it("accepts the -a / -t short forms and leaves the optional flags unset", async () => {
    await runCli("setup", "-a", "http://api.test", "-t", "bv_u_human");

    expect(runSetupMock).toHaveBeenCalledWith({
      apiUrl: "http://api.test",
      userToken: "bv_u_human",
      deviceName: undefined,
      externalId: undefined,
      configRoot: undefined,
    });
    expect(exitMock).not.toHaveBeenCalled();
  });

  it.each([
    ["--api alone", ["setup", "--api", "http://api.test"]],
    ["--user-token alone", ["setup", "--user-token", "bv_u_human"]],
    ["no flags at all", ["setup"]],
  ])("exits 2 when %s is supplied", async (_label, args) => {
    await runCli(...args);

    expect(errorMock).toHaveBeenCalledWith(
      "setup requires --api and --user-token",
    );
    expect(exitMock).toHaveBeenCalledWith(2);
  });

  it("treats a value-less trailing flag as absent rather than eating the next arg", async () => {
    await runCli("setup", "--user-token", "bv_u_human", "--api");

    expect(errorMock).toHaveBeenCalledWith(
      "setup requires --api and --user-token",
    );
    expect(exitMock).toHaveBeenCalledWith(2);
  });
});

describe("start", () => {
  it("runs with no config-root override by default", async () => {
    await runCli("start");

    expect(runStartMock).toHaveBeenCalledWith({ configRoot: undefined });
  });

  it("passes --config-root through", async () => {
    await runCli("start", "--config-root", "/tmp/root-b");

    expect(runStartMock).toHaveBeenCalledWith({ configRoot: "/tmp/root-b" });
  });
});

describe("sync", () => {
  it("says nothing was found when the detector adds no runtime", async () => {
    await runCli("sync");

    expect(runSyncMock).toHaveBeenCalledWith({ configRoot: undefined });
    expect(printed()).toContain("No new CLIs detected.");
    expect(printed()).not.toContain("Restart the daemon");
  });

  it("lists the added runtimes and tells the operator to restart", async () => {
    runSyncMock.mockResolvedValue({
      added: [
        { id: "rt_codex", cli: "codex" },
        { id: "rt_opencode", cli: "opencode" },
      ],
    });

    await runCli("sync", "--config-root", "/tmp/root-c");

    expect(runSyncMock).toHaveBeenCalledWith({ configRoot: "/tmp/root-c" });
    expect(printed()).toContain(
      "Added 2 runtime(s): codex (rt_codex), opencode (rt_opencode).",
    );
    expect(printed()).toContain("Restart the daemon to pick up the new runtime(s).");
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

describe("config-root resolution", () => {
  it("falls back to the env var when the flag is absent", async () => {
    process.env[CONFIG_ROOT_ENV] = "/tmp/from-env";

    await runCli("start");

    expect(runStartMock).toHaveBeenCalledWith({ configRoot: "/tmp/from-env" });
  });

  it("prefers the flag over the env var", async () => {
    process.env[CONFIG_ROOT_ENV] = "/tmp/from-env";

    await runCli("start", "--config-root", "/tmp/from-flag");

    expect(runStartMock).toHaveBeenCalledWith({ configRoot: "/tmp/from-flag" });
  });

  it("treats an empty env var as unset", async () => {
    process.env[CONFIG_ROOT_ENV] = "";

    await runCli("start");

    expect(runStartMock).toHaveBeenCalledWith({ configRoot: undefined });
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("never consults the dev gate when neither knob is set", async () => {
    await runCli("start");

    expect(isDevBuildMock).not.toHaveBeenCalled();
  });

  it("rejects the flag in a compiled build, naming the flag", async () => {
    isDevBuildMock.mockReturnValue(false);

    await runCli("start", "--config-root", "/tmp/from-flag");

    expect(exitMock).toHaveBeenCalledWith(2);
    const message = String(errorMock.mock.calls[0]![0]);
    expect(message).toContain("--config-root is a dev-only knob");
    expect(message).toContain("pnpm dev");
  });

  it("rejects the env var in a compiled build, naming the env var", async () => {
    isDevBuildMock.mockReturnValue(false);
    process.env[CONFIG_ROOT_ENV] = "/tmp/from-env";

    await runCli("start");

    expect(exitMock).toHaveBeenCalledWith(2);
    expect(String(errorMock.mock.calls[0]![0])).toContain(
      `${CONFIG_ROOT_ENV} is a dev-only knob`,
    );
  });
});

describe("top-level failure handling", () => {
  it("prints the stack and exits 1 when a command rejects with an Error", async () => {
    const boom = new Error("no daemon config found");
    runStartMock.mockRejectedValue(boom);

    await runCli("start");

    expect(errorMock).toHaveBeenCalledWith(boom.stack);
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("stringifies a non-Error rejection", async () => {
    runSyncMock.mockRejectedValue("socket hang up");

    await runCli("sync");

    expect(errorMock).toHaveBeenCalledWith("socket hang up");
    expect(exitMock).toHaveBeenCalledWith(1);
  });
});
