/**
 * Unit tests for the five MCP tools exposed to the child agent.
 *
 * These are the *only* way an untrusted child session touches the
 * container, so the contract worth pinning is: arguments are validated
 * before they reach `docker.ts`, oversized output is capped before it
 * reaches the model's context, and a `SandboxError` surfaces as a
 * message rather than crashing the server.
 *
 * `./docker.js` is mocked — the primitives themselves are covered in
 * `docker.test.ts`.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./docker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./docker.js")>();
  return {
    ...actual,
    exec: vi.fn(),
    exportArtifact: vi.fn(),
    listDir: vi.fn(),
    readFileIn: vi.fn(),
    writeFileIn: vi.fn(),
  };
});

import type { ExecResult, Sandbox } from "./docker.js";

const docker = await import("./docker.js");
const { capBytes, makeTools, optionalNumber, optionalString, requireString } =
  await import("./tools.js");
const { SandboxError } = docker;

const sandbox: Sandbox = {
  id: "bv-run-test",
  image: "python:3.12-slim",
  artifact_dir: "/tmp/bv-run-test-artifacts",
  created_at: new Date("2026-01-01T00:00:00Z"),
};

/** Look up a tool by name the way the MCP server's dispatch map does. */
function tool(name: string): ReturnType<typeof makeTools>[number] {
  const t = makeTools(sandbox).find((x) => x.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  return t;
}

const execResult = (over: Partial<ExecResult> = {}): ExecResult => ({
  stdout: "",
  stderr: "",
  exit_code: 0,
  timed_out: false,
  duration_seconds: 0.1,
  ...over,
});

beforeEach(() => {
  vi.mocked(docker.exec).mockResolvedValue(execResult());
  vi.mocked(docker.listDir).mockResolvedValue([]);
  vi.mocked(docker.readFileIn).mockResolvedValue("");
  vi.mocked(docker.writeFileIn).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("tool surface", () => {
  it("exposes exactly the five tools the orchestrator allowlists", () => {
    expect(makeTools(sandbox).map((t) => t.name)).toEqual([
      "sandbox_exec",
      "sandbox_read_file",
      "sandbox_write_file",
      "sandbox_list",
      "sandbox_export_artifact",
    ]);
  });

  it("marks every tool's required arguments in its input schema", () => {
    const required = Object.fromEntries(
      makeTools(sandbox).map((t) => [t.name, t.inputSchema.required]),
    );
    expect(required).toEqual({
      sandbox_exec: ["cmd"],
      sandbox_read_file: ["path"],
      sandbox_write_file: ["path", "content"],
      sandbox_list: ["path"],
      sandbox_export_artifact: ["sandbox_path"],
    });
  });
});

describe("sandbox_exec", () => {
  it("forwards cmd, cwd and timeout to the container and returns the result", async () => {
    vi.mocked(docker.exec).mockResolvedValue(
      execResult({ stdout: "ok\n", exit_code: 0, duration_seconds: 1.5 }),
    );

    const r = await tool("sandbox_exec").handler({
      cmd: "pytest -q",
      cwd: "/sandbox/repo",
      timeout_seconds: 60,
    });

    expect(docker.exec).toHaveBeenCalledWith(sandbox, "pytest -q", {
      cwd: "/sandbox/repo",
      timeout_seconds: 60,
    });
    expect(r).toEqual({
      stdout: "ok\n",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      duration_seconds: 1.5,
    });
  });

  it("leaves cwd and timeout undefined so docker.ts applies its defaults", async () => {
    await tool("sandbox_exec").handler({ cmd: "ls" });

    expect(docker.exec).toHaveBeenCalledWith(sandbox, "ls", {
      cwd: undefined,
      timeout_seconds: undefined,
    });
  });

  it("reports a failed command instead of throwing", async () => {
    vi.mocked(docker.exec).mockResolvedValue(
      execResult({ stderr: "ModuleNotFoundError\n", exit_code: 1 }),
    );

    const r = (await tool("sandbox_exec").handler({ cmd: "python x.py" })) as {
      exit_code: number;
      stderr: string;
    };

    expect(r.exit_code).toBe(1);
    expect(r.stderr).toBe("ModuleNotFoundError\n");
  });

  it("passes a timed-out flag through so the agent can back off", async () => {
    vi.mocked(docker.exec).mockResolvedValue(
      execResult({ exit_code: -1, timed_out: true }),
    );

    const r = (await tool("sandbox_exec").handler({ cmd: "sleep 999" })) as {
      timed_out: boolean;
    };

    expect(r.timed_out).toBe(true);
  });

  it("caps runaway stdout at 64KB and stderr at 16KB", async () => {
    vi.mocked(docker.exec).mockResolvedValue(
      execResult({ stdout: "o".repeat(70_000), stderr: "e".repeat(20_000) }),
    );

    const r = (await tool("sandbox_exec").handler({ cmd: "cat huge.log" })) as {
      stdout: string;
      stderr: string;
    };

    expect(r.stdout.startsWith("o".repeat(64_000))).toBe(true);
    expect(r.stdout).toContain("[truncated 6000 bytes]");
    expect(r.stderr.startsWith("e".repeat(16_000))).toBe(true);
    expect(r.stderr).toContain("[truncated 4000 bytes]");
  });

  it("rejects a missing cmd before touching the container", async () => {
    await expect(tool("sandbox_exec").handler({})).rejects.toThrow(
      /missing or invalid "cmd"/,
    );
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it("rejects a non-string cwd and a non-number timeout", async () => {
    await expect(
      tool("sandbox_exec").handler({ cmd: "ls", cwd: 42 }),
    ).rejects.toThrow(/invalid "cwd" \(string expected\)/);
    await expect(
      tool("sandbox_exec").handler({ cmd: "ls", timeout_seconds: "60" }),
    ).rejects.toThrow(/invalid "timeout_seconds" \(number expected\)/);
    expect(docker.exec).not.toHaveBeenCalled();
  });
});

describe("sandbox_read_file", () => {
  it("returns the file contents", async () => {
    vi.mocked(docker.readFileIn).mockResolvedValue("# README\n");

    const r = await tool("sandbox_read_file").handler({ path: "/sandbox/repo/README.md" });

    expect(docker.readFileIn).toHaveBeenCalledWith(sandbox, "/sandbox/repo/README.md", {
      max_bytes: undefined,
    });
    expect(r).toEqual({ content: "# README\n" });
  });

  it("forwards an explicit max_bytes", async () => {
    await tool("sandbox_read_file").handler({ path: "/sandbox/a", max_bytes: 512 });

    expect(docker.readFileIn).toHaveBeenCalledWith(sandbox, "/sandbox/a", {
      max_bytes: 512,
    });
  });

  it("propagates a SandboxError so the server can mark the call failed", async () => {
    vi.mocked(docker.readFileIn).mockRejectedValue(new SandboxError("read /nope failed"));

    await expect(
      tool("sandbox_read_file").handler({ path: "/nope" }),
    ).rejects.toThrow(SandboxError);
  });

  it("rejects a missing path", async () => {
    await expect(tool("sandbox_read_file").handler({})).rejects.toThrow(
      /missing or invalid "path"/,
    );
  });
});

describe("sandbox_write_file", () => {
  it("writes the content and acknowledges", async () => {
    const r = await tool("sandbox_write_file").handler({
      path: "/sandbox/glue.py",
      content: "print(1)",
    });

    expect(docker.writeFileIn).toHaveBeenCalledWith(sandbox, "/sandbox/glue.py", "print(1)");
    expect(r).toEqual({ ok: true });
  });

  it("accepts empty content", async () => {
    await tool("sandbox_write_file").handler({ path: "/sandbox/empty", content: "" });

    expect(docker.writeFileIn).toHaveBeenCalledWith(sandbox, "/sandbox/empty", "");
  });

  it("rejects a non-string content before writing anything", async () => {
    await expect(
      tool("sandbox_write_file").handler({ path: "/sandbox/x", content: { a: 1 } }),
    ).rejects.toThrow(/missing or invalid "content"/);
    expect(docker.writeFileIn).not.toHaveBeenCalled();
  });
});

describe("sandbox_list", () => {
  it("returns the directory entries", async () => {
    vi.mocked(docker.listDir).mockResolvedValue(["a.py", "b.py"]);

    const r = await tool("sandbox_list").handler({ path: "/sandbox/repo" });

    expect(docker.listDir).toHaveBeenCalledWith(sandbox, "/sandbox/repo");
    expect(r).toEqual({ entries: ["a.py", "b.py"] });
  });

  it("rejects a missing path", async () => {
    await expect(tool("sandbox_list").handler({})).rejects.toThrow(
      /missing or invalid "path"/,
    );
  });
});

describe("sandbox_export_artifact", () => {
  let artifactDir: string;

  beforeEach(async () => {
    artifactDir = await mkdtemp(join(tmpdir(), "bv-tools-test-"));
  });

  afterEach(async () => {
    await rm(artifactDir, { recursive: true, force: true });
  });

  it("exports the file and writes a sidecar carrying the title", async () => {
    const hostPath = join(artifactDir, "report.pdf");
    vi.mocked(docker.exportArtifact).mockResolvedValue({
      host_path: hostPath,
      size_bytes: 2048,
    });

    const r = await tool("sandbox_export_artifact").handler({
      sandbox_path: "/sandbox/artifacts/report.pdf",
      title: "Quarterly report",
    });

    expect(r).toEqual({
      host_path: hostPath,
      size_bytes: 2048,
      title: "Quarterly report",
    });

    const sidecar = JSON.parse(await readFile(`${hostPath}.meta.json`, "utf8"));
    expect(sidecar).toMatchObject({
      sandbox_path: "/sandbox/artifacts/report.pdf",
      host_path: hostPath,
      size_bytes: 2048,
      title: "Quarterly report",
    });
    expect(typeof sidecar.exported_at).toBe("string");
  });

  it("falls back to the basename when no title is given", async () => {
    const hostPath = join(artifactDir, "out.csv");
    vi.mocked(docker.exportArtifact).mockResolvedValue({
      host_path: hostPath,
      size_bytes: 10,
    });

    const r = (await tool("sandbox_export_artifact").handler({
      sandbox_path: "/sandbox/artifacts/out.csv",
    })) as { title: string };

    expect(r.title).toBe("out.csv");
    const sidecar = JSON.parse(await readFile(`${hostPath}.meta.json`, "utf8"));
    expect(sidecar.title).toBe("out.csv");
  });

  it("still returns the artifact when the sidecar can't be written", async () => {
    // Host path under a directory that doesn't exist — the sidecar write
    // throws, but the artifact itself was already copied out.
    const hostPath = join(artifactDir, "missing-dir", "x.txt");
    vi.mocked(docker.exportArtifact).mockResolvedValue({
      host_path: hostPath,
      size_bytes: 5,
    });

    const r = await tool("sandbox_export_artifact").handler({
      sandbox_path: "/sandbox/artifacts/x.txt",
      title: "X",
    });

    expect(r).toEqual({ host_path: hostPath, size_bytes: 5, title: "X" });
  });

  it("propagates an export failure", async () => {
    vi.mocked(docker.exportArtifact).mockRejectedValue(
      new SandboxError("export /sandbox/nope failed"),
    );

    await expect(
      tool("sandbox_export_artifact").handler({ sandbox_path: "/sandbox/nope" }),
    ).rejects.toThrow(/export \/sandbox\/nope failed/);
  });

  it("rejects a non-string title", async () => {
    await expect(
      tool("sandbox_export_artifact").handler({ sandbox_path: "/sandbox/a", title: 7 }),
    ).rejects.toThrow(/invalid "title" \(string expected\)/);
    expect(docker.exportArtifact).not.toHaveBeenCalled();
  });
});

describe("argument validators", () => {
  it("requireString accepts a string and rejects everything else", () => {
    expect(requireString({ k: "v" }, "k")).toBe("v");
    expect(requireString({ k: "" }, "k")).toBe("");
    for (const bad of [undefined, null, 1, true, {}, []]) {
      expect(() => requireString({ k: bad }, "k")).toThrow(SandboxError);
    }
  });

  it("optionalString treats undefined and null as absent", () => {
    expect(optionalString({}, "k")).toBeUndefined();
    expect(optionalString({ k: null }, "k")).toBeUndefined();
    expect(optionalString({ k: "v" }, "k")).toBe("v");
    expect(() => optionalString({ k: 1 }, "k")).toThrow(SandboxError);
  });

  it("optionalNumber treats undefined and null as absent", () => {
    expect(optionalNumber({}, "k")).toBeUndefined();
    expect(optionalNumber({ k: null }, "k")).toBeUndefined();
    expect(optionalNumber({ k: 0 }, "k")).toBe(0);
    expect(() => optionalNumber({ k: "1" }, "k")).toThrow(SandboxError);
  });

  // Both optionals share one implementation parameterized by type tag, so
  // the message has to keep naming the type the caller actually asked for.
  it("names the expected type and the offending key in the message", () => {
    expect(() => optionalString({ k: 1 }, "k")).toThrow('invalid "k" (string expected)');
    expect(() => optionalNumber({ k: "1" }, "k")).toThrow('invalid "k" (number expected)');
  });
});

describe("capBytes", () => {
  it("returns short input untouched", () => {
    expect(capBytes("abc", 10)).toBe("abc");
  });

  it("returns input exactly at the cap untouched", () => {
    expect(capBytes("abcde", 5)).toBe("abcde");
  });

  it("truncates and reports how much was dropped", () => {
    expect(capBytes("abcdefghij", 4)).toBe("abcd\n…[truncated 6 bytes]…\n");
  });
});
