import { beforeEach, describe, expect, it, vi } from "vitest";
import { KNOWN_CLIS } from "@beevibe/core";
import { detectClis } from "./detect-clis.js";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

type ExecCallback = (err: Error | null, out?: { stdout: string; stderr: string }) => void;

/**
 * Drive the promisified `execFile` from a table of
 * `"<cmd> <args…>" -> stdout | Error`. Anything not in the table fails,
 * which models "not on PATH" for `which` probes.
 */
function program(table: Record<string, string | Error>): void {
  execFileMock.mockImplementation(
    (cmd: string, args: string[], cb: ExecCallback) => {
      const key = [cmd, ...args].join(" ");
      const outcome = table[key];
      if (outcome === undefined) {
        cb(new Error(`command failed: ${key}`));
        return;
      }
      if (outcome instanceof Error) {
        cb(outcome);
        return;
      }
      cb(null, { stdout: outcome, stderr: "" });
    },
  );
}

/** Every CLI on PATH, each reporting `<cli> 1.0.0`. */
function allPresent(): Record<string, string | Error> {
  return Object.fromEntries(
    KNOWN_CLIS.flatMap((cli) => [
      [`which ${cli}`, `/usr/local/bin/${cli}\n`],
      [`${cli} --version`, `${cli} 1.0.0\n`],
    ]),
  );
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe("detectClis", () => {
  it("reports every known CLI on PATH with its version", async () => {
    program(allPresent());

    await expect(detectClis()).resolves.toEqual(
      KNOWN_CLIS.map((cli) => ({ cli, cli_version: `${cli} 1.0.0` })),
    );
  });

  it("returns an empty list when nothing is on PATH", async () => {
    program({});

    await expect(detectClis()).resolves.toEqual([]);
    // Still probed once per known CLI — no early bail-out.
    expect(execFileMock).toHaveBeenCalledTimes(KNOWN_CLIS.length);
  });

  it("omits CLIs whose `which` lookup fails and never asks them for a version", async () => {
    const table = allPresent();
    delete table[`which ${KNOWN_CLIS[1]}`];
    program(table);

    const detected = await detectClis();

    expect(detected.map((d) => d.cli)).toEqual(
      KNOWN_CLIS.filter((c) => c !== KNOWN_CLIS[1]),
    );
    const invoked = execFileMock.mock.calls.map(
      (c: unknown[]) => [c[0], ...(c[1] as string[])].join(" "),
    );
    expect(invoked).not.toContain(`${KNOWN_CLIS[1]} --version`);
  });

  it("keeps a CLI whose --version errors, with no version attached", async () => {
    const table = allPresent();
    table[`${KNOWN_CLIS[0]} --version`] = new Error("exit 1");
    program(table);

    const detected = await detectClis();

    expect(detected[0]).toEqual({ cli: KNOWN_CLIS[0], cli_version: undefined });
    expect(detected).toHaveLength(KNOWN_CLIS.length);
  });

  it("keeps only the first line of a multi-line version banner", async () => {
    const table = allPresent();
    table[`${KNOWN_CLIS[0]} --version`] =
      "1.2.3 (Claude Code)\nnode v22.0.0\nplatform darwin\n";
    program(table);

    const [first] = await detectClis();

    expect(first?.cli_version).toBe("1.2.3 (Claude Code)");
  });

  it("preserves KNOWN_CLIS order regardless of which probe settles first", async () => {
    const table = allPresent();
    const rank = (cmd: string, args: string[]): number =>
      KNOWN_CLIS.indexOf((cmd === "which" ? args[0] : cmd) as never);
    execFileMock.mockImplementation(
      (cmd: string, args: string[], cb: ExecCallback) => {
        const outcome = table[[cmd, ...args].join(" ")] as string;
        // Reverse declaration order: the last known CLI answers first.
        const delay = (KNOWN_CLIS.length - rank(cmd, args)) * 2;
        setTimeout(() => cb(null, { stdout: outcome, stderr: "" }), delay);
      },
    );

    const detected = await detectClis();

    expect(detected.map((d) => d.cli)).toEqual([...KNOWN_CLIS]);
  });
});
