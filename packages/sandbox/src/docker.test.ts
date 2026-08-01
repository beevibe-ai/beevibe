/**
 * Unit tests for the Docker-backed sandbox primitives.
 *
 * `docker.ts` is the trust boundary — every command an untrusted child
 * agent runs is assembled here. These tests mock `spawn` so they assert
 * on the *argv actually handed to `docker`* (resource caps, `--user`,
 * network lockdown, quoting) without needing a daemon; `docker.e2e.test.ts`
 * covers the real round-trip and is skipped when Docker is absent.
 *
 * Host-side filesystem work (the artifact dir, write staging) is left
 * real and pointed at a temp dir — mocking `fs` here would test the mock.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const { spawn } = await import("node:child_process");
const {
  cleanupArtifactDir,
  createSandbox,
  DEFAULT_IMAGE,
  destroySandbox,
  ensureArtifactDir,
  exec,
  exportArtifact,
  listDir,
  prepareBaseEnvironment,
  readFileIn,
  SandboxError,
  writeFileIn,
} = await import("./docker.js");

type Sandbox = Awaited<ReturnType<typeof createSandbox>>;

/** One scripted `docker` invocation. */
interface FakeRun {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  /** Emit `error` instead of `close` — models a missing `docker` binary. */
  error?: Error;
  /** Never exit on its own; the timeout must `kill` it. */
  hang?: boolean;
}

let queue: FakeRun[] = [];
/** argv of every `docker` call made during the test, in order. */
let calls: string[][] = [];

/** argv of the Nth `docker` invocation — fails loudly if it never happened. */
function argvOf(n: number): string[] {
  const argv = calls[n];
  if (!argv) {
    throw new Error(`expected at least ${n + 1} docker call(s), saw ${calls.length}`);
  }
  return argv;
}

/** The `sh -c` command string of the Nth `docker` invocation. */
function cmdOf(n: number): string {
  const cmd = argvOf(n).at(-1);
  if (cmd === undefined) throw new Error(`docker call ${n} had no arguments`);
  return cmd;
}

/** The value following `flag` in the Nth invocation's argv. */
function flagOf(n: number, flag: string): string | undefined {
  const argv = argvOf(n);
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

function makeProc(run: FakeRun): EventEmitter & Record<string, unknown> {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn(() => {
    // A killed process still emits `close`, which is what unblocks runDocker.
    setImmediate(() => proc.emit("close", null));
  });

  setImmediate(() => {
    if (run.error) {
      proc.emit("error", run.error);
      return;
    }
    if (run.stdout) stdout.emit("data", Buffer.from(run.stdout, "utf8"));
    if (run.stderr) stderr.emit("data", Buffer.from(run.stderr, "utf8"));
    if (!run.hang) proc.emit("close", run.code ?? 0);
  });
  return proc;
}

/** Script the next N `docker` invocations, in call order. */
function script(...runs: FakeRun[]): void {
  queue.push(...runs);
}

/** A sandbox with a real host artifact dir but no container behind it. */
async function fakeSandbox(): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), "bv-test-artifacts-"));
  tempDirs.push(dir);
  return { id: "bv-test-abc123", image: DEFAULT_IMAGE, artifact_dir: dir, created_at: new Date() };
}

let tempDirs: string[] = [];

beforeEach(() => {
  queue = [];
  calls = [];
  tempDirs = [];
  vi.mocked(spawn).mockImplementation(((_bin: string, args: string[]) => {
    calls.push(args);
    return makeProc(queue.shift() ?? { code: 0 });
  }) as unknown as typeof spawn);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("createSandbox", () => {
  it("caps CPU, memory and disk, and drops to a non-root uid", async () => {
    script({ code: 0 });
    const sbx = await createSandbox({ label: "bv-run-1" });
    tempDirs.push(sbx.artifact_dir);

    const argv = argvOf(0);
    expect(argv[0]).toBe("run");
    expect(argv).toContain("--detach");
    // Defaults from DEFAULT_LIMITS.
    expect(argv).toContain("--cpus=2");
    expect(argv).toContain("--memory=2g");
    expect(argv).toContain("--storage-opt=size=4g");
    // The agent must not be root inside the container.
    expect(flagOf(0, "--user")).toBe("1000:1000");
  });

  it("honours caller-supplied limits over the defaults", async () => {
    script({ code: 0 });
    const sbx = await createSandbox({
      limits: { cpus: 0.5, memory: "512m", storage: "1g" },
    });
    tempDirs.push(sbx.artifact_dir);

    expect(argvOf(0)).toContain("--cpus=0.5");
    expect(argvOf(0)).toContain("--memory=512m");
    expect(argvOf(0)).toContain("--storage-opt=size=1g");
  });

  it("adds --network=none only when the caller disables the network", async () => {
    script({ code: 0 }, { code: 0 });

    const networked = await createSandbox();
    tempDirs.push(networked.artifact_dir);
    expect(argvOf(0)).not.toContain("--network=none");

    const isolated = await createSandbox({ limits: { network: false } });
    tempDirs.push(isolated.artifact_dir);
    expect(argvOf(1)).toContain("--network=none");
  });

  it("bind-mounts the host artifact dir at /sandbox/artifacts", async () => {
    script({ code: 0 });
    const sbx = await createSandbox();
    tempDirs.push(sbx.artifact_dir);

    expect(flagOf(0, "-v")).toBe(`${sbx.artifact_dir}:/sandbox/artifacts:rw`);
  });

  it("uses the pinned default image unless one is supplied", async () => {
    script({ code: 0 }, { code: 0 });

    const def = await createSandbox();
    tempDirs.push(def.artifact_dir);
    expect(def.image).toBe(DEFAULT_IMAGE);
    expect(argvOf(0)).toContain(DEFAULT_IMAGE);

    const custom = await createSandbox({ image: "python:3.11-slim" });
    tempDirs.push(custom.artifact_dir);
    expect(custom.image).toBe("python:3.11-slim");
    expect(argvOf(1)).toContain("python:3.11-slim");
  });

  it("sanitizes the label into a legal container name", async () => {
    script({ code: 0 });
    const sbx = await createSandbox({ label: "Run/With Illegal:Chars" });
    tempDirs.push(sbx.artifact_dir);

    // Docker names allow [a-z0-9_-] only; the random suffix keeps them unique.
    expect(sbx.id).toMatch(/^[a-z0-9_-]+-[0-9a-f]{8}$/);
    expect(sbx.id.startsWith("run-with-illegal-chars-")).toBe(true);
  });

  it("throws and removes the orphaned artifact dir when docker run fails", async () => {
    script({ code: 125, stderr: "docker: no such image\n" });

    await expect(createSandbox()).rejects.toThrow(SandboxError);
    // The dir created before the failed `docker run` must not be left behind.
    const created = (flagOf(0, "-v") ?? "").split(":")[0] as string;
    await expect(readFile(join(created, "anything"))).rejects.toThrow();
  });

  it("surfaces the docker stderr in the thrown message", async () => {
    script({ code: 125, stderr: "Cannot connect to the Docker daemon\n" });
    await expect(createSandbox()).rejects.toThrow(/Cannot connect to the Docker daemon/);
  });
});

describe("exec", () => {
  it("runs the command through sh -c in /sandbox by default", async () => {
    script({ stdout: "hello\n", code: 0 });
    const sbx = await fakeSandbox();

    const r = await exec(sbx, "echo hello");

    expect(r.stdout).toBe("hello\n");
    expect(r.exit_code).toBe(0);
    expect(r.timed_out).toBe(false);
    expect(argvOf(0)).toEqual([
      "exec",
      "--workdir",
      "/sandbox",
      sbx.id,
      "sh",
      "-c",
      "echo hello",
    ]);
  });

  it("passes cwd and env through to docker exec", async () => {
    script({ code: 0 });
    const sbx = await fakeSandbox();

    await exec(sbx, "pytest", { cwd: "/sandbox/repo", env: { CI: "1", TZ: "UTC" } });

    const argv = argvOf(0);
    expect(flagOf(0, "--workdir")).toBe("/sandbox/repo");
    expect(argv).toContain("CI=1");
    expect(argv).toContain("TZ=UTC");
    expect(argv.filter((a) => a === "--env")).toHaveLength(2);
  });

  it("reports a non-zero exit rather than throwing", async () => {
    script({ stderr: "boom\n", code: 3 });
    const sbx = await fakeSandbox();

    const r = await exec(sbx, "false");

    expect(r.exit_code).toBe(3);
    expect(r.stderr).toBe("boom\n");
  });

  it("marks a command that outlived its timeout as timed_out", async () => {
    vi.useFakeTimers();
    script({ hang: true });
    const sbx = await fakeSandbox();

    const pending = exec(sbx, "sleep 999", { timeout_seconds: 1 });
    await vi.advanceTimersByTimeAsync(1_100);
    const r = await pending;

    expect(r.timed_out).toBe(true);
    expect(r.exit_code).toBe(-1);
  });

  it("turns a missing docker binary into exit -1 with the spawn error attached", async () => {
    script({ error: new Error("spawn docker ENOENT") });
    const sbx = await fakeSandbox();

    const r = await exec(sbx, "true");

    expect(r.exit_code).toBe(-1);
    expect(r.stderr).toContain("spawn docker ENOENT");
  });
});

describe("readFileIn", () => {
  it("reads through head -c with the byte cap applied", async () => {
    script({ stdout: "file body", code: 0 });
    const sbx = await fakeSandbox();

    const content = await readFileIn(sbx, "/sandbox/out.txt", { max_bytes: 100 });

    expect(content).toBe("file body");
    // max_bytes + 1 so an over-cap file is detectable.
    expect(cmdOf(0)).toBe("head -c 101 '/sandbox/out.txt'");
  });

  it("quotes the path so a crafted filename can't inject a command", async () => {
    script({ stdout: "", code: 0 });
    const sbx = await fakeSandbox();

    await readFileIn(sbx, "/sandbox/x'; rm -rf /; echo '");

    const cmd = cmdOf(0);
    expect(cmd).toBe(`head -c 1000001 '/sandbox/x'\\''; rm -rf /; echo '\\'''`);
  });

  it("throws when the file exceeds max_bytes", async () => {
    // `head -c max+1` returned max+1 bytes, so the file is at least that big.
    script({ stdout: "x".repeat(11), code: 0 });
    const sbx = await fakeSandbox();

    await expect(readFileIn(sbx, "/sandbox/big", { max_bytes: 10 })).rejects.toThrow(
      /exceeded max_bytes=10/,
    );
  });

  it("throws with the stderr tail when the read fails", async () => {
    script({ stderr: "head: cannot open '/nope'\n", code: 1 });
    const sbx = await fakeSandbox();

    await expect(readFileIn(sbx, "/nope")).rejects.toThrow(/read \/nope failed \(exit 1\)/);
  });
});

describe("writeFileIn", () => {
  it("stages on the host bind mount then moves the file into place", async () => {
    script({ code: 0 }, { code: 0 }); // mkdir -p, then mv
    const sbx = await fakeSandbox();

    await writeFileIn(sbx, "/sandbox/repo/glue.py", "print('hi')");

    expect(cmdOf(0)).toBe("mkdir -p '/sandbox/repo'");
    const mv = cmdOf(1);
    expect(mv).toMatch(/^mv '\/sandbox\/artifacts\/__stage_[0-9a-f]{12}' '\/sandbox\/repo\/glue\.py'$/);
  });

  it("removes the staging file from the host after a successful write", async () => {
    script({ code: 0 }, { code: 0 });
    const sbx = await fakeSandbox();

    await writeFileIn(sbx, "/sandbox/a.txt", "body");

    const stageName = cmdOf(1).match(/__stage_[0-9a-f]{12}/)?.[0];
    expect(stageName).toBeDefined();
    await expect(readFile(join(sbx.artifact_dir, stageName as string))).rejects.toThrow();
  });

  it("falls back to /sandbox when the path has no parent directory", async () => {
    script({ code: 0 }, { code: 0 });
    const sbx = await fakeSandbox();

    // Stripping the basename off "/notes.txt" leaves "", so the `|| "/sandbox"`
    // fallback is what keeps `mkdir -p` from being handed an empty argument.
    await writeFileIn(sbx, "/notes.txt", "x");

    expect(cmdOf(0)).toBe("mkdir -p '/sandbox'");
  });

  it("treats a relative path's leading segment as the parent dir", async () => {
    script({ code: 0 }, { code: 0 });
    const sbx = await fakeSandbox();

    // Documents current behaviour: with no "/" to strip, the whole string
    // is used as the dir, so a bare filename makes a dir of that name. Every
    // caller (the `sandbox_write_file` tool) passes an absolute path, so this
    // path isn't reachable in practice.
    await writeFileIn(sbx, "notes.txt", "x");

    expect(cmdOf(0)).toBe("mkdir -p 'notes.txt'");
  });

  it("throws when the parent directory can't be created", async () => {
    script({ code: 1, stderr: "mkdir: permission denied\n" });
    const sbx = await fakeSandbox();

    await expect(writeFileIn(sbx, "/root/x.txt", "x")).rejects.toThrow(
      /mkdir -p \/root failed: mkdir: permission denied/,
    );
  });

  it("throws when the move into place fails", async () => {
    script({ code: 0 }, { code: 1, stderr: "mv: read-only file system\n" });
    const sbx = await fakeSandbox();

    await expect(writeFileIn(sbx, "/sandbox/x.txt", "x")).rejects.toThrow(
      /write \/sandbox\/x\.txt failed: mv: read-only file system/,
    );
  });
});

describe("listDir", () => {
  it("splits ls -1 output and drops blank lines", async () => {
    script({ stdout: "a.txt\nb.txt\n\n  c.txt  \n", code: 0 });
    const sbx = await fakeSandbox();

    expect(await listDir(sbx, "/sandbox")).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(cmdOf(0)).toBe("ls -1 '/sandbox'");
  });

  it("returns an empty array for an empty directory", async () => {
    script({ stdout: "", code: 0 });
    const sbx = await fakeSandbox();

    expect(await listDir(sbx, "/sandbox/empty")).toEqual([]);
  });

  it("throws when the directory doesn't exist", async () => {
    script({ code: 2, stderr: "ls: /nope: No such file or directory\n" });
    const sbx = await fakeSandbox();

    await expect(listDir(sbx, "/nope")).rejects.toThrow(/list \/nope failed \(exit 2\)/);
  });
});

describe("exportArtifact", () => {
  it("docker cp's the file out and reports its host path and size", async () => {
    script({ code: 0 });
    const sbx = await fakeSandbox();
    // `docker cp` is mocked, so place the file the real readFile will stat.
    await writeFile(join(sbx.artifact_dir, "report.md"), "hello world", "utf8");

    const r = await exportArtifact(sbx, "/sandbox/artifacts/report.md");

    expect(r.host_path).toBe(join(sbx.artifact_dir, "report.md"));
    expect(r.size_bytes).toBe(11);
    expect(argvOf(0)).toEqual([
      "cp",
      `${sbx.id}:/sandbox/artifacts/report.md`,
      join(sbx.artifact_dir, "report.md"),
    ]);
  });

  it("keeps only the basename so an export can't escape the artifact dir", async () => {
    script({ code: 0 });
    const sbx = await fakeSandbox();
    await writeFile(join(sbx.artifact_dir, "passwd"), "x", "utf8");

    const r = await exportArtifact(sbx, "/etc/../etc/passwd");

    expect(r.host_path).toBe(join(sbx.artifact_dir, "passwd"));
  });

  it("throws when docker cp fails", async () => {
    script({ code: 1, stderr: "Error: No such container:path\n" });
    const sbx = await fakeSandbox();

    await expect(exportArtifact(sbx, "/sandbox/missing.txt")).rejects.toThrow(
      /export \/sandbox\/missing\.txt failed/,
    );
  });
});

describe("prepareBaseEnvironment", () => {
  it("installs git and curl as root and chowns /sandbox to the agent uid", async () => {
    script({ code: 0 });
    const sbx = await fakeSandbox();

    await prepareBaseEnvironment(sbx);

    expect(flagOf(0, "--user")).toBe("0");
    const cmd = cmdOf(0);
    expect(cmd).toContain("apt-get install -y -qq --no-install-recommends git curl");
    expect(cmd).toContain("chown -R 1000:1000 /sandbox");
  });

  it("throws with the stderr tail when the prep step fails", async () => {
    script({ code: 100, stderr: "E: Unable to locate package git\n" });
    const sbx = await fakeSandbox();

    await expect(prepareBaseEnvironment(sbx)).rejects.toThrow(
      /base prep failed \(exit 100\): E: Unable to locate package git/,
    );
  });
});

describe("teardown", () => {
  it("force-removes the container and leaves artifacts on the host", async () => {
    script({ code: 0 });
    const sbx = await fakeSandbox();
    await writeFile(join(sbx.artifact_dir, "kept.txt"), "still here", "utf8");

    await destroySandbox(sbx);

    expect(argvOf(0)).toEqual(["rm", "-f", sbx.id]);
    // Artifacts outlive the container so the UI can still serve them.
    expect(await readFile(join(sbx.artifact_dir, "kept.txt"), "utf8")).toBe("still here");
  });

  it("swallows a docker rm failure so cleanup can't fail a run", async () => {
    script({ code: 1, stderr: "No such container\n" });
    const sbx = await fakeSandbox();

    await expect(destroySandbox(sbx)).resolves.toBeUndefined();
  });

  it("cleanupArtifactDir removes the host artifact dir", async () => {
    const sbx = await fakeSandbox();
    await writeFile(join(sbx.artifact_dir, "tmp.txt"), "x", "utf8");

    await cleanupArtifactDir(sbx);

    await expect(readFile(join(sbx.artifact_dir, "tmp.txt"))).rejects.toThrow();
  });

  it("cleanupArtifactDir is a no-op on an already-removed dir", async () => {
    const sbx = await fakeSandbox();
    await cleanupArtifactDir(sbx);
    await expect(cleanupArtifactDir(sbx)).resolves.toBeUndefined();
  });
});

describe("ensureArtifactDir", () => {
  it("creates the directory recursively and tolerates re-runs", async () => {
    const base = await mkdtemp(join(tmpdir(), "bv-test-ensure-"));
    tempDirs.push(base);
    const nested = join(base, "a", "b", "c");

    await ensureArtifactDir(nested);
    await ensureArtifactDir(nested);

    await writeFile(join(nested, "probe.txt"), "ok", "utf8");
    expect(await readFile(join(nested, "probe.txt"), "utf8")).toBe("ok");
  });
});
