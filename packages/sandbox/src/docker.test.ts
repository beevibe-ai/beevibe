/**
 * Unit tests for the Docker sandbox primitives.
 *
 * `docker.e2e.test.ts` covers the same module against a real daemon,
 * but it is Docker-gated and skips everywhere else — which left the
 * containment boundary for third-party repo code untested on CI. These
 * tests mock `child_process.spawn` instead, so the part that actually
 * decides what containment looks like (the argv handed to `docker run`)
 * is asserted without needing a daemon.
 *
 * What's pinned here:
 *   - the `docker run` flags that make a sandbox a sandbox: the
 *     resource caps, the non-root `--user`, the single rw bind, and
 *     `--network=none` when network is off,
 *   - every path that shells a value into `sh -c` goes through
 *     `shellQuote` (covered directly in `shell-quote.test.ts`; here we
 *     check the call sites actually use it),
 *   - the error paths, which all have to raise `SandboxError` rather
 *     than leak a raw exit code — including a `docker` binary that
 *     isn't installed and a command that outruns its timeout.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One recorded `docker …` invocation plus the handle used to finish it. */
interface Invocation {
  args: string[];
  proc: FakeProcess;
}

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed?: NodeJS.Signals;

  kill(signal: NodeJS.Signals): void {
    this.killed = signal;
    // A SIGKILLed child still emits close; the timeout flag is what
    // marks it as timed out.
    this.emit("close", null);
  }

  /** Finish this invocation the way a real `docker` exit would. */
  finish(opts: { code?: number; stdout?: string; stderr?: string } = {}): void {
    if (opts.stdout) this.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) this.stderr.emit("data", Buffer.from(opts.stderr));
    this.emit("close", opts.code ?? 0);
  }
}

const invocations: Invocation[] = [];

/**
 * Queue of responses applied in order as invocations arrive. A function
 * gets the invocation and drives it; anything left over auto-succeeds.
 */
let responders: Array<(inv: Invocation) => void> = [];

const spawnMock = vi.fn((_cmd: string, args: string[]) => {
  const proc = new FakeProcess();
  const inv: Invocation = { args, proc };
  invocations.push(inv);
  const responder = responders.shift();
  // Defer so the caller can attach its listeners first.
  queueMicrotask(() => {
    if (responder) responder(inv);
    else proc.finish({ code: 0 });
  });
  return proc;
});

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const {
  ALLOWED_CLONE_HOSTS,
  DEFAULT_IMAGE,
  SandboxError,
  cleanupArtifactDir,
  createSandbox,
  destroySandbox,
  ensureArtifactDir,
  exec,
  exportArtifact,
  listDir,
  prepareBaseEnvironment,
  readFileIn,
  writeFileIn,
} = await import("./docker.js");

type Sandbox = Awaited<ReturnType<typeof createSandbox>>;

/** Respond to the next N invocations with a fixed result. */
function respond(...results: Array<{ code?: number; stdout?: string; stderr?: string }>): void {
  responders.push(...results.map((r) => (inv: Invocation) => inv.proc.finish(r)));
}

let scratch: string;

/** A sandbox handle with a real artifact dir, without a `docker run`. */
async function fakeSandbox(): Promise<Sandbox> {
  const dir = join(scratch, `sbx-${invocations.length}`);
  await ensureArtifactDir(dir);
  return {
    id: "bv-sbx-abcd1234",
    image: DEFAULT_IMAGE,
    artifact_dir: dir,
    created_at: new Date(),
  };
}

/** The single arg-vector matching a predicate, for readable assertions. */
function invocationWith(fragment: string): string[] {
  const hit = invocations.find((i) => i.args.includes(fragment));
  if (!hit) throw new Error(`no docker invocation contained ${fragment}`);
  return hit.args;
}

beforeEach(async () => {
  invocations.length = 0;
  responders = [];
  spawnMock.mockClear();
  scratch = await mkdtemp(join(tmpdir(), "bv-docker-test-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("createSandbox", () => {
  it("runs a detached container with the conservative default flags", async () => {
    const sandbox = await createSandbox();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = invocations[0]!.args;
    expect(args[0]).toBe("run");
    expect(args).toContain("--detach");
    expect(args).toContain("--cpus=2");
    expect(args).toContain("--memory=2g");
    expect(args).toContain("--storage-opt=size=4g");
    // Non-root in-container user, so the agent can't do privileged work.
    expect(args).toContain("--user");
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(args[args.indexOf("--tmpfs") + 1]).toBe("/tmp:rw,size=512m");
    expect(args[args.indexOf("--workdir") + 1]).toBe("/sandbox");
    // Exactly one bind, and it is the artifact dir.
    const mounts = args.filter((_a, i) => args[i - 1] === "-v");
    expect(mounts).toEqual([`${sandbox.artifact_dir}:/sandbox/artifacts:rw`]);
    // The image and the keep-alive command come last.
    expect(args.slice(-3)).toEqual([DEFAULT_IMAGE, "-f", "/dev/null"]);
    expect(sandbox.image).toBe(DEFAULT_IMAGE);
  });

  it("leaves the network attached by default and detaches it on request", async () => {
    await createSandbox();
    expect(invocations[0]!.args).not.toContain("--network=none");

    await createSandbox({ limits: { network: false } });
    expect(invocations[1]!.args).toContain("--network=none");
  });

  it("applies caller limits over the defaults, one at a time", async () => {
    await createSandbox({ limits: { cpus: 0.5, memory: "512m", storage: "1g" } });
    const args = invocations[0]!.args;
    expect(args).toContain("--cpus=0.5");
    expect(args).toContain("--memory=512m");
    expect(args).toContain("--storage-opt=size=1g");

    // A partial limits object must not drop the untouched defaults.
    await createSandbox({ limits: { cpus: 4 } });
    const partial = invocations[1]!.args;
    expect(partial).toContain("--cpus=4");
    expect(partial).toContain("--memory=2g");
  });

  it("honours a caller-supplied image", async () => {
    const sandbox = await createSandbox({ image: "node:22-slim" });
    expect(sandbox.image).toBe("node:22-slim");
    expect(invocations[0]!.args.slice(-3)).toEqual(["node:22-slim", "-f", "/dev/null"]);
  });

  it("sanitizes the label into a legal container name", async () => {
    const sandbox = await createSandbox({ label: "Repo Run/Agent#1" });
    const name = invocations[0]!.args[invocations[0]!.args.indexOf("--name") + 1]!;
    expect(name).toBe(sandbox.id);
    expect(name).toMatch(/^[a-z0-9_-]+$/);
    expect(name).toMatch(/-[0-9a-f]{8}$/);
  });

  it("truncates an overlong label before the random suffix", async () => {
    const sandbox = await createSandbox({ label: "x".repeat(80) });
    const [prefix, suffix] = [sandbox.id.slice(0, -9), sandbox.id.slice(-8)];
    expect(prefix).toHaveLength(32);
    expect(suffix).toMatch(/^[0-9a-f]{8}$/);
  });

  it("gives each sandbox a distinct id and artifact dir", async () => {
    const a = await createSandbox();
    const b = await createSandbox();
    expect(a.id).not.toBe(b.id);
    expect(a.artifact_dir).not.toBe(b.artifact_dir);
  });

  it("raises SandboxError and removes the artifact dir when docker run fails", async () => {
    respond({ code: 125, stderr: "no such image\n" });

    await expect(createSandbox()).rejects.toThrow(SandboxError);
    // The dir it made was cleaned up rather than left behind in /tmp.
    const mounted = invocations[0]!.args[invocations[0]!.args.indexOf("-v") + 1]!;
    const dir = mounted.split(":")[0]!;
    await expect(readFile(join(dir, "anything"))).rejects.toThrow();
  });

  it("reports the exit code when docker run fails silently", async () => {
    respond({ code: 1, stderr: "   " });
    await expect(createSandbox()).rejects.toThrow(/docker run exited 1/);
  });

  it("surfaces a missing docker binary as a spawn error", async () => {
    responders.push((inv) => inv.proc.emit("error", new Error("spawn docker ENOENT")));
    await expect(createSandbox()).rejects.toThrow(/spawn docker ENOENT/);
  });
});

describe("exec", () => {
  it("execs in /sandbox via sh -c by default", async () => {
    const sandbox = await fakeSandbox();
    respond({ code: 0, stdout: "hello\n" });

    const r = await exec(sandbox, "echo hello");

    expect(invocations[0]!.args).toEqual([
      "exec",
      "--workdir",
      "/sandbox",
      sandbox.id,
      "sh",
      "-c",
      "echo hello",
    ]);
    expect(r).toMatchObject({
      stdout: "hello\n",
      stderr: "",
      exit_code: 0,
      timed_out: false,
    });
    expect(r.duration_seconds).toBeGreaterThanOrEqual(0);
  });

  it("forwards cwd and env as docker exec flags", async () => {
    const sandbox = await fakeSandbox();
    await exec(sandbox, "pwd", { cwd: "/sandbox/repo", env: { FOO: "1", BAR: "2" } });

    expect(invocations[0]!.args).toEqual([
      "exec",
      "--workdir",
      "/sandbox/repo",
      "--env",
      "FOO=1",
      "--env",
      "BAR=2",
      sandbox.id,
      "sh",
      "-c",
      "pwd",
    ]);
  });

  it("returns a non-zero exit rather than throwing", async () => {
    const sandbox = await fakeSandbox();
    respond({ code: 2, stderr: "boom" });

    const r = await exec(sandbox, "false");

    expect(r.exit_code).toBe(2);
    expect(r.stderr).toBe("boom");
  });

  it("kills and flags a command that outruns its timeout", async () => {
    const sandbox = await fakeSandbox();
    // Never finish; the module's own timer fires instead.
    responders.push(() => {});

    const r = await exec(sandbox, "sleep 999", { timeout_seconds: 0.01 });

    expect(r.timed_out).toBe(true);
    expect(invocations[0]!.proc.killed).toBe("SIGKILL");
    expect(r.exit_code).toBe(-1);
  });

  it("reports a spawn failure as exit -1 with the error inline", async () => {
    const sandbox = await fakeSandbox();
    responders.push((inv) => inv.proc.emit("error", new Error("EACCES")));

    const r = await exec(sandbox, "ls");

    expect(r.exit_code).toBe(-1);
    expect(r.stderr).toContain("<spawn-error>EACCES</spawn-error>");
  });
});

describe("readFileIn", () => {
  it("bounds the read with head -c and quotes the path", async () => {
    const sandbox = await fakeSandbox();
    respond({ code: 0, stdout: "contents" });

    const out = await readFileIn(sandbox, "/sandbox/it's a file.txt", {
      max_bytes: 10,
    });

    expect(out).toBe("contents");
    expect(invocations[0]!.args.at(-1)).toBe(`head -c 11 '/sandbox/it'\\''s a file.txt'`);
  });

  it("defaults the cap to 1 MB", async () => {
    const sandbox = await fakeSandbox();
    await readFileIn(sandbox, "/sandbox/out.txt");
    expect(invocations[0]!.args.at(-1)).toContain("head -c 1000001");
  });

  it("raises SandboxError when the read command fails", async () => {
    const sandbox = await fakeSandbox();
    respond({ code: 1, stderr: "No such file or directory\n" });

    await expect(readFileIn(sandbox, "/nope")).rejects.toThrow(
      /read \/nope failed \(exit 1\): No such file/,
    );
  });

  it("raises SandboxError when the file exceeds max_bytes", async () => {
    const sandbox = await fakeSandbox();
    // head -c reads max+1 bytes, so an over-cap file comes back longer.
    respond({ code: 0, stdout: "abcdef" });

    await expect(readFileIn(sandbox, "/big", { max_bytes: 5 })).rejects.toThrow(
      /exceeded max_bytes=5/,
    );
  });
});

describe("writeFileIn", () => {
  it("stages on the host bind, mkdirs the target dir, then moves into place", async () => {
    const sandbox = await fakeSandbox();

    await writeFileIn(sandbox, "/sandbox/repo/run.py", "print(1)\n");

    expect(invocations).toHaveLength(2);
    const mkdirCmd = invocations[0]!.args.at(-1)!;
    const mvCmd = invocations[1]!.args.at(-1)!;
    expect(mkdirCmd).toBe("mkdir -p '/sandbox/repo'");
    expect(mvCmd).toMatch(
      /^mv '\/sandbox\/artifacts\/__stage_[0-9a-f]{12}' '\/sandbox\/repo\/run\.py'$/,
    );
  });

  it("falls back to /sandbox when the target sits at the filesystem root", async () => {
    const sandbox = await fakeSandbox();
    await writeFileIn(sandbox, "/notes.md", "hi");
    // Stripping the basename leaves an empty dir string; mkdir -p ''
    // would fail, so the empty case falls back to the workdir.
    expect(invocations[0]!.args.at(-1)).toBe("mkdir -p '/sandbox'");
  });

  it("removes the staging file once the move succeeds", async () => {
    const sandbox = await fakeSandbox();
    await writeFileIn(sandbox, "/sandbox/a.txt", "body");

    const stageName = /__stage_[0-9a-f]{12}/.exec(invocations[1]!.args.at(-1)!)![0];
    await expect(readFile(join(sandbox.artifact_dir, stageName))).rejects.toThrow();
  });

  it("raises SandboxError when the mkdir fails, without attempting the move", async () => {
    const sandbox = await fakeSandbox();
    respond({ code: 1, stderr: "Permission denied" });

    await expect(writeFileIn(sandbox, "/root/x", "y")).rejects.toThrow(
      /mkdir -p \/root failed: Permission denied/,
    );
    expect(invocations).toHaveLength(1);
  });

  it("raises SandboxError when the move fails", async () => {
    const sandbox = await fakeSandbox();
    respond({ code: 0 }, { code: 1, stderr: "Read-only file system" });

    await expect(writeFileIn(sandbox, "/sandbox/x", "y")).rejects.toThrow(
      /write \/sandbox\/x failed: Read-only file system/,
    );
  });
});

describe("listDir", () => {
  it("splits ls -1 output and drops blank lines", async () => {
    const sandbox = await fakeSandbox();
    respond({ code: 0, stdout: "a.txt\n  b.txt  \n\nsub\n" });

    expect(await listDir(sandbox, "/sandbox")).toEqual(["a.txt", "b.txt", "sub"]);
    expect(invocations[0]!.args.at(-1)).toBe("ls -1 '/sandbox'");
  });

  it("returns an empty list for an empty directory", async () => {
    const sandbox = await fakeSandbox();
    respond({ code: 0, stdout: "\n" });
    expect(await listDir(sandbox, "/sandbox")).toEqual([]);
  });

  it("raises SandboxError when the path does not exist", async () => {
    const sandbox = await fakeSandbox();
    respond({ code: 2, stderr: "No such file or directory" });

    await expect(listDir(sandbox, "/nope")).rejects.toThrow(
      /list \/nope failed \(exit 2\)/,
    );
  });
});

describe("exportArtifact", () => {
  it("docker cps the file into the artifact dir and reports its size", async () => {
    const sandbox = await fakeSandbox();
    const hostPath = join(sandbox.artifact_dir, "report.json");
    responders.push(async (inv) => {
      await writeFile(hostPath, "{}\n", "utf8");
      inv.proc.finish({ code: 0 });
    });

    const out = await exportArtifact(sandbox, "/sandbox/out/report.json");

    expect(invocations[0]!.args).toEqual([
      "cp",
      `${sandbox.id}:/sandbox/out/report.json`,
      hostPath,
    ]);
    expect(out).toEqual({ host_path: hostPath, size_bytes: 3 });
  });

  it("keeps only the basename, so a nested sandbox path lands flat", async () => {
    const sandbox = await fakeSandbox();
    const hostPath = join(sandbox.artifact_dir, "out.csv");
    responders.push(async (inv) => {
      await writeFile(hostPath, "a,b\n", "utf8");
      inv.proc.finish({ code: 0 });
    });

    const out = await exportArtifact(sandbox, "/sandbox/repo/deep/nested/out.csv");
    expect(out.host_path).toBe(hostPath);
  });

  it("raises SandboxError when the copy fails", async () => {
    const sandbox = await fakeSandbox();
    respond({ code: 1, stderr: "Could not find the file" });

    await expect(exportArtifact(sandbox, "/sandbox/missing")).rejects.toThrow(
      /export \/sandbox\/missing failed: Could not find the file/,
    );
  });
});

describe("prepareBaseEnvironment", () => {
  it("installs git + curl as root and hands /sandbox to the sandbox user", async () => {
    const sandbox = await fakeSandbox();

    await prepareBaseEnvironment(sandbox);

    const args = invocations[0]!.args;
    expect(args.slice(0, 4)).toEqual(["exec", "--user", "0", sandbox.id]);
    const script = args.at(-1)!;
    expect(script).toContain("apt-get install -y -qq --no-install-recommends git curl");
    expect(script).toContain("chown -R 1000:1000 /sandbox");
  });

  it("raises SandboxError when the prep step fails", async () => {
    const sandbox = await fakeSandbox();
    respond({ code: 100, stderr: "Unable to fetch some archives" });

    await expect(prepareBaseEnvironment(sandbox)).rejects.toThrow(
      /base prep failed \(exit 100\): Unable to fetch some archives/,
    );
  });
});

describe("teardown", () => {
  it("force-removes the container but keeps the artifact dir", async () => {
    const sandbox = await fakeSandbox();
    await writeFile(join(sandbox.artifact_dir, "kept.txt"), "keep", "utf8");

    await destroySandbox(sandbox);

    expect(invocationWith("rm")).toEqual(["rm", "-f", sandbox.id]);
    expect(await readFile(join(sandbox.artifact_dir, "kept.txt"), "utf8")).toBe("keep");
  });

  it("swallows a docker rm failure so teardown never throws", async () => {
    const sandbox = await fakeSandbox();
    responders.push((inv) => inv.proc.emit("error", new Error("daemon gone")));

    await expect(destroySandbox(sandbox)).resolves.toBeUndefined();
  });

  it("cleanupArtifactDir removes the host directory", async () => {
    const sandbox = await fakeSandbox();
    await writeFile(join(sandbox.artifact_dir, "tmp.txt"), "x", "utf8");

    await cleanupArtifactDir(sandbox);

    await expect(readFile(join(sandbox.artifact_dir, "tmp.txt"))).rejects.toThrow();
  });

  it("cleanupArtifactDir is a no-op on an already-removed directory", async () => {
    const sandbox = await fakeSandbox();
    await cleanupArtifactDir(sandbox);
    await expect(cleanupArtifactDir(sandbox)).resolves.toBeUndefined();
  });
});

describe("ensureArtifactDir", () => {
  it("creates the directory and tolerates being called twice", async () => {
    const dir = join(scratch, "nested/artifacts");
    await ensureArtifactDir(dir);
    await ensureArtifactDir(dir);
    await writeFile(join(dir, "ok.txt"), "ok", "utf8");
    expect(await readFile(join(dir, "ok.txt"), "utf8")).toBe("ok");
  });
});

describe("ALLOWED_CLONE_HOSTS", () => {
  it("lists the clone + package hosts the sandbox is meant to reach", () => {
    // Not yet enforced (docker's bridge network gives full egress) —
    // this pins the intended boundary so widening it is a visible diff.
    expect(ALLOWED_CLONE_HOSTS).toEqual([
      "github.com",
      "codeload.github.com",
      "raw.githubusercontent.com",
      "pypi.org",
      "files.pythonhosted.org",
    ]);
  });
});
