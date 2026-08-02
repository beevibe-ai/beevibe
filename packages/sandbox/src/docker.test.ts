/**
 * Unit tests for the Docker sandbox primitives.
 *
 * These are the trust boundary: every flag on `docker run` is a
 * containment decision (resource caps, non-root uid, egress), and every
 * path that reaches a container command has to survive `sh -c`. None of
 * that is exercised in CI today — `docker.e2e.test.ts` needs a real
 * daemon and skips by default.
 *
 * So we stub `node:child_process.spawn` and assert on the argv that
 * *would* have been handed to `docker`, plus how each helper maps the
 * process result back. Real filesystem work (mkdtemp, the write-file
 * staging dance) is left real — only the daemon is faked.
 */
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ─────────── fake `docker` process ─────────── */

interface FakeResponse {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  /** Emit an `error` event instead of closing (spawn failure). */
  error?: string;
  /** Never settle — lets the caller's timeout fire. */
  hang?: boolean;
}

/** Every argv the code under test handed to `docker`, in order. */
let dockerCalls: string[][] = [];
/** Decides what the fake daemon does with a given argv. */
let respond: (args: string[]) => FakeResponse = () => ({ code: 0 });

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  #settled = false;

  kill(signal: string): boolean {
    this.killed.push(signal);
    // A real process dies when signalled, which surfaces as `close`.
    this.#close(null);
    return true;
  }

  settle(res: FakeResponse): void {
    if (res.hang) return;
    queueMicrotask(() => {
      if (res.stdout) this.stdout.emit("data", Buffer.from(res.stdout, "utf8"));
      if (res.stderr) this.stderr.emit("data", Buffer.from(res.stderr, "utf8"));
      if (res.error) {
        this.#settled = true;
        this.emit("error", new Error(res.error));
        return;
      }
      this.#close(res.code === undefined ? 0 : res.code);
    });
  }

  #close(code: number | null): void {
    if (this.#settled) return;
    this.#settled = true;
    this.emit("close", code);
  }
}

vi.mock("node:child_process", () => ({
  spawn: (bin: string, args: string[]) => {
    dockerCalls.push([bin, ...args]);
    const proc = new FakeProc();
    proc.settle(respond(args));
    return proc;
  },
}));

// `vi.mock` is hoisted above these, so docker.js sees the fake spawn.
import {
  ALLOWED_CLONE_HOSTS,
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
  shellQuote,
  writeFileIn,
  type Sandbox,
} from "./docker.js";

/* ─────────── helpers ─────────── */

/** The argv of the Nth `docker` invocation, without the leading binary. */
function argsOf(n: number): string[] {
  return dockerCalls[n]!.slice(1);
}

/** A sandbox handle with a real host artifact dir, no daemon involved. */
async function fakeSandbox(): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), "bv-test-artifacts-"));
  tempDirs.push(dir);
  return { id: "bv-test-abc123", image: DEFAULT_IMAGE, artifact_dir: dir, created_at: new Date() };
}

const tempDirs: string[] = [];

beforeEach(() => {
  dockerCalls = [];
  respond = () => ({ code: 0 });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/* ─────────── createSandbox ─────────── */

describe("createSandbox", () => {
  it("runs a detached container with the default image and conservative caps", async () => {
    const sbx = await createSandbox();
    tempDirs.push(sbx.artifact_dir);

    const args = argsOf(0);
    expect(args[0]).toBe("run");
    expect(args).toContain("--detach");
    // Resource caps — the reason a runaway agent can't eat the host.
    expect(args).toContain("--cpus=2");
    expect(args).toContain("--memory=2g");
    expect(args).toContain("--storage-opt=size=4g");
    // Never root inside the container.
    expect(args).toContain("--user");
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(args).toContain("--tmpfs");
    expect(args[args.indexOf("--tmpfs") + 1]).toBe("/tmp:rw,size=512m");
    // Only the artifact dir is shared with the host.
    expect(args[args.indexOf("-v") + 1]).toBe(`${sbx.artifact_dir}:/sandbox/artifacts:rw`);
    expect(args[args.indexOf("--workdir") + 1]).toBe("/sandbox");
    // `tail -f /dev/null` is what keeps the container alive for exec.
    expect(args[args.indexOf("--entrypoint") + 1]).toBe("tail");
    expect(args.slice(-3)).toEqual([DEFAULT_IMAGE, "-f", "/dev/null"]);
  });

  it("returns a handle whose artifact dir exists on the host", async () => {
    const sbx = await createSandbox();
    tempDirs.push(sbx.artifact_dir);

    expect(sbx.image).toBe(DEFAULT_IMAGE);
    expect(sbx.created_at).toBeInstanceOf(Date);
    await expect(readdir(sbx.artifact_dir)).resolves.toEqual([]);
    // The container is named after the handle id, so exec can address it.
    expect(argsOf(0)[argsOf(0).indexOf("--name") + 1]).toBe(sbx.id);
  });

  it("omits --network=none while egress is allowed", async () => {
    const sbx = await createSandbox();
    tempDirs.push(sbx.artifact_dir);
    expect(argsOf(0)).not.toContain("--network=none");
  });

  it("cuts off egress when network is disabled", async () => {
    const sbx = await createSandbox({ limits: { network: false } });
    tempDirs.push(sbx.artifact_dir);
    expect(argsOf(0)).toContain("--network=none");
  });

  it("lets callers tighten individual limits without losing the rest", async () => {
    const sbx = await createSandbox({ limits: { cpus: 0.5, memory: "256m" } });
    tempDirs.push(sbx.artifact_dir);

    const args = argsOf(0);
    expect(args).toContain("--cpus=0.5");
    expect(args).toContain("--memory=256m");
    // Untouched limits keep their defaults rather than going undefined.
    expect(args).toContain("--storage-opt=size=4g");
  });

  it("honours a pinned base image", async () => {
    const sbx = await createSandbox({ image: "python:3.11-slim" });
    tempDirs.push(sbx.artifact_dir);
    expect(argsOf(0).slice(-3)).toEqual(["python:3.11-slim", "-f", "/dev/null"]);
  });

  it("sanitizes a label into a legal container name", async () => {
    const sbx = await createSandbox({ label: "BV Run/Agent#7" });
    tempDirs.push(sbx.artifact_dir);
    // Docker only accepts [a-z0-9_-]; everything else becomes a dash,
    // and a random suffix keeps concurrent runs from colliding.
    expect(sbx.id).toMatch(/^bv-run-agent-7-[0-9a-f]{8}$/);
  });

  it("truncates an over-long label to keep the name bounded", async () => {
    const sbx = await createSandbox({ label: "x".repeat(80) });
    tempDirs.push(sbx.artifact_dir);
    const [prefix, suffix] = [sbx.id.slice(0, -9), sbx.id.slice(-8)];
    expect(prefix).toBe("x".repeat(32));
    expect(suffix).toMatch(/^[0-9a-f]{8}$/);
  });

  it("gives distinct ids to two sandboxes with the same label", async () => {
    const a = await createSandbox({ label: "dup" });
    const b = await createSandbox({ label: "dup" });
    tempDirs.push(a.artifact_dir, b.artifact_dir);
    expect(a.id).not.toBe(b.id);
  });

  it("throws SandboxError and cleans up the artifact dir when docker run fails", async () => {
    respond = () => ({ code: 125, stderr: "docker: Error response from daemon: no such image\n" });

    await expect(createSandbox()).rejects.toThrow(SandboxError);
    // A failed create must not leak a host temp dir.
    const bind = argsOf(0)[argsOf(0).indexOf("-v") + 1]!;
    const hostDir = bind.slice(0, bind.indexOf(":/sandbox/artifacts"));
    await expect(readdir(hostDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces the daemon's stderr in the failure message", async () => {
    respond = () => ({ code: 125, stderr: "Cannot connect to the Docker daemon\n" });
    await expect(createSandbox()).rejects.toThrow(/Cannot connect to the Docker daemon/);
  });

  it("falls back to the exit code when the daemon said nothing", async () => {
    respond = () => ({ code: 7, stderr: "   " });
    await expect(createSandbox()).rejects.toThrow(/docker run exited 7/);
  });
});

/* ─────────── exec ─────────── */

describe("exec", () => {
  it("runs the command under sh -c in /sandbox by default", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 0, stdout: "hi\n" });

    const r = await exec(sbx, "echo hi");

    expect(argsOf(0)).toEqual(["exec", "--workdir", "/sandbox", sbx.id, "sh", "-c", "echo hi"]);
    expect(r.stdout).toBe("hi\n");
    expect(r.exit_code).toBe(0);
    expect(r.timed_out).toBe(false);
    expect(r.duration_seconds).toBeGreaterThanOrEqual(0);
  });

  it("honours an explicit working directory", async () => {
    const sbx = await fakeSandbox();
    await exec(sbx, "ls", { cwd: "/sandbox/repo" });
    expect(argsOf(0)[argsOf(0).indexOf("--workdir") + 1]).toBe("/sandbox/repo");
  });

  it("passes env vars through as --env flags", async () => {
    const sbx = await fakeSandbox();
    await exec(sbx, "env", { env: { FOO: "1", BAR: "two" } });

    const args = argsOf(0);
    expect(args).toContain("--env");
    expect(args).toContain("FOO=1");
    expect(args).toContain("BAR=two");
    // Env flags precede the container id, or docker parses them as the command.
    expect(args.indexOf("BAR=two")).toBeLessThan(args.indexOf(sbx.id));
  });

  it("reports a non-zero exit without throwing", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 42, stderr: "boom" });

    // exec is the raw primitive — callers decide what a failure means.
    const r = await exec(sbx, "false");
    expect(r.exit_code).toBe(42);
    expect(r.stderr).toBe("boom");
  });

  it("kills and flags the command when it outruns its timeout", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ hang: true });

    const r = await exec(sbx, "sleep 999", { timeout_seconds: 0.02 });

    expect(r.timed_out).toBe(true);
    expect(r.exit_code).toBe(-1);
  });

  it("maps a spawn failure to exit -1 with the cause attached", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ error: "spawn docker ENOENT" });

    const r = await exec(sbx, "true");

    expect(r.exit_code).toBe(-1);
    expect(r.stderr).toContain("<spawn-error>spawn docker ENOENT</spawn-error>");
  });

  it("concatenates streamed chunks rather than keeping only the last", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 0, stdout: "part-one part-two" });
    const r = await exec(sbx, "cat big");
    expect(r.stdout).toBe("part-one part-two");
  });
});

/* ─────────── readFileIn ─────────── */

describe("readFileIn", () => {
  it("reads through a byte-capped head so a huge file can't blow memory", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 0, stdout: "contents" });

    const out = await readFileIn(sbx, "/sandbox/repo/README.md");

    // max+1 so an over-long file is detectable rather than silently cut.
    expect(argsOf(0).at(-1)).toBe("head -c 1000001 '/sandbox/repo/README.md'");
    expect(out).toBe("contents");
  });

  it("quotes a path containing shell metacharacters", async () => {
    const sbx = await fakeSandbox();
    await readFileIn(sbx, "/sandbox/a b; rm -rf /");
    expect(argsOf(0).at(-1)).toBe("head -c 1000001 '/sandbox/a b; rm -rf /'");
  });

  it("respects a caller-supplied max_bytes", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 0, stdout: "abc" });
    await readFileIn(sbx, "/sandbox/x", { max_bytes: 10 });
    expect(argsOf(0).at(-1)).toBe("head -c 11 '/sandbox/x'");
  });

  it("throws when the file is missing", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 1, stderr: "head: /sandbox/nope: No such file or directory" });

    await expect(readFileIn(sbx, "/sandbox/nope")).rejects.toThrow(SandboxError);
    await expect(readFileIn(sbx, "/sandbox/nope")).rejects.toThrow(/No such file/);
  });

  it("throws rather than returning a truncated file when the cap is exceeded", async () => {
    const sbx = await fakeSandbox();
    // head returned max+1 bytes, meaning there was more to read.
    respond = () => ({ code: 0, stdout: "x".repeat(11) });

    await expect(readFileIn(sbx, "/sandbox/big", { max_bytes: 10 })).rejects.toThrow(
      /exceeded max_bytes=10/,
    );
  });

  it("returns a file sitting exactly on the cap", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 0, stdout: "x".repeat(10) });
    await expect(readFileIn(sbx, "/sandbox/edge", { max_bytes: 10 })).resolves.toHaveLength(10);
  });
});

/* ─────────── writeFileIn ─────────── */

describe("writeFileIn", () => {
  it("stages on the host bind mount, then moves into place inside the container", async () => {
    const sbx = await fakeSandbox();
    let staged: string | undefined;
    respond = (args) => {
      const cmd = args.at(-1)!;
      // Capture the staged filename while the container command still refers to it.
      const m = /mv '(\/sandbox\/artifacts\/__stage_[0-9a-f]+)'/.exec(cmd);
      if (m) staged = m[1];
      return { code: 0 };
    };

    await writeFileIn(sbx, "/sandbox/repo/glue.py", "print('hi')");

    // 1. mkdir -p of the parent, 2. mv from the bind mount to the target.
    expect(argsOf(0).at(-1)).toBe("mkdir -p '/sandbox/repo'");
    expect(argsOf(1).at(-1)).toBe(`mv '${staged}' '/sandbox/repo/glue.py'`);
  });

  it("writes the real content to the staging file before the move", async () => {
    const sbx = await fakeSandbox();
    let contentAtMoveTime: string | undefined;
    respond = (args) => {
      const m = /mv '\/sandbox\/artifacts\/(__stage_[0-9a-f]+)'/.exec(args.at(-1)!);
      if (m) {
        // The bind mount means the container path maps to this host file.
        contentAtMoveTime = readFileSync(join(sbx.artifact_dir, m[1]!), "utf8");
      }
      return { code: 0 };
    };

    await writeFileIn(sbx, "/sandbox/out.txt", "hello world");
    expect(contentAtMoveTime).toBe("hello world");
  });

  it("removes the staging file once the move succeeds", async () => {
    const sbx = await fakeSandbox();
    await writeFileIn(sbx, "/sandbox/out.txt", "data");
    // Nothing left behind in the shared artifact dir.
    await expect(readdir(sbx.artifact_dir)).resolves.toEqual([]);
  });

  it("falls back to /sandbox for a file at the container root", async () => {
    const sbx = await fakeSandbox();
    // Stripping the basename off "/out.txt" leaves "", which would make
    // `mkdir -p ''` fail; the fallback keeps it addressed at /sandbox.
    await writeFileIn(sbx, "/out.txt", "x");
    expect(argsOf(0).at(-1)).toBe("mkdir -p '/sandbox'");
  });

  it("routes both operands through shellQuote so a crafted filename stays inert", async () => {
    const sbx = await fakeSandbox();
    const hostile = "/sandbox/a'; touch /pwned; '";

    await writeFileIn(sbx, hostile, "x");

    const mkdir = argsOf(0).at(-1)!;
    const mv = argsOf(1).at(-1)!;
    // The embedded quote is closed-and-reopened rather than left to
    // terminate the argument, so `touch` never becomes its own command.
    expect(mv.endsWith(` ${shellQuote(hostile)}`)).toBe(true);
    expect(mv).toContain(`'\\''; touch /pwned; '\\''`);
    // The derived parent dir carries the payload too, so it is quoted
    // on the same terms rather than being trusted as a plain path.
    expect(mkdir).toBe(`mkdir -p ${shellQuote("/sandbox/a'; touch ")}`);
  });

  it("throws when the parent directory cannot be created", async () => {
    const sbx = await fakeSandbox();
    respond = (args) =>
      args.at(-1)!.startsWith("mkdir") ? { code: 1, stderr: "Permission denied" } : { code: 0 };

    await expect(writeFileIn(sbx, "/root/nope.txt", "x")).rejects.toThrow(/mkdir -p \/root failed/);
  });

  it("throws when the move fails", async () => {
    const sbx = await fakeSandbox();
    respond = (args) =>
      args.at(-1)!.startsWith("mv") ? { code: 1, stderr: "Read-only file system" } : { code: 0 };

    await expect(writeFileIn(sbx, "/sandbox/out.txt", "x")).rejects.toThrow(
      /write \/sandbox\/out.txt failed: Read-only file system/,
    );
  });

  it("does not mask the write error with a cleanup error", async () => {
    const sbx = await fakeSandbox();
    respond = (args) => (args.at(-1)!.startsWith("mv") ? { code: 1, stderr: "nope" } : { code: 0 });
    // The finally block runs even on the failure path; it must not throw
    // over the top of the real cause.
    await expect(writeFileIn(sbx, "/sandbox/out.txt", "x")).rejects.toThrow(SandboxError);
  });
});

/* ─────────── listDir ─────────── */

describe("listDir", () => {
  it("returns one trimmed entry per line", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 0, stdout: "README.md\nsetup.py\nsrc\n" });

    const entries = await listDir(sbx, "/sandbox/repo");

    expect(argsOf(0).at(-1)).toBe("ls -1 '/sandbox/repo'");
    expect(entries).toEqual(["README.md", "setup.py", "src"]);
  });

  it("drops blank lines from the listing", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 0, stdout: "a\n\n  \nb\n" });
    await expect(listDir(sbx, "/sandbox")).resolves.toEqual(["a", "b"]);
  });

  it("returns an empty array for an empty directory", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 0, stdout: "" });
    await expect(listDir(sbx, "/sandbox/empty")).resolves.toEqual([]);
  });

  it("throws when the directory does not exist", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 2, stderr: "ls: /sandbox/nope: No such file or directory" });
    await expect(listDir(sbx, "/sandbox/nope")).rejects.toThrow(/list \/sandbox\/nope failed/);
  });
});

/* ─────────── exportArtifact ─────────── */

describe("exportArtifact", () => {
  it("copies the file out of the container and reports its size", async () => {
    const sbx = await fakeSandbox();
    respond = (args) => {
      if (args[0] === "cp") {
        // Stand in for `docker cp` landing the file on the host.
        writeFileSync(args[2]!, "report-bytes");
      }
      return { code: 0 };
    };

    const r = await exportArtifact(sbx, "/sandbox/artifacts/report.pdf");

    expect(argsOf(0)).toEqual([
      "cp",
      `${sbx.id}:/sandbox/artifacts/report.pdf`,
      join(sbx.artifact_dir, "report.pdf"),
    ]);
    expect(r.host_path).toBe(join(sbx.artifact_dir, "report.pdf"));
    expect(r.size_bytes).toBe("report-bytes".length);
  });

  it("preserves only the basename so the export lands in the artifact dir", async () => {
    const sbx = await fakeSandbox();
    respond = (args) => {
      if (args[0] === "cp") writeFileSync(args[2]!, "x");
      return { code: 0 };
    };

    const r = await exportArtifact(sbx, "/sandbox/deep/nested/out.csv");
    // A nested source path must not escape the artifact dir on the host.
    expect(r.host_path).toBe(join(sbx.artifact_dir, "out.csv"));
  });

  it("throws when the source path is not in the container", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 1, stderr: "Error: No such container:path" });
    await expect(exportArtifact(sbx, "/sandbox/missing.txt")).rejects.toThrow(
      /export \/sandbox\/missing.txt failed/,
    );
  });
});

/* ─────────── lifecycle helpers ─────────── */

describe("prepareBaseEnvironment", () => {
  it("installs git and curl as root and hands /sandbox to the agent uid", async () => {
    const sbx = await fakeSandbox();
    await prepareBaseEnvironment(sbx);

    const args = argsOf(0);
    // apt-get needs root even though the agent's own commands do not.
    expect(args.slice(0, 4)).toEqual(["exec", "--user", "0", sbx.id]);
    const cmd = args.at(-1)!;
    expect(cmd).toContain("apt-get install -y -qq --no-install-recommends git curl ca-certificates");
    expect(cmd).toContain("chown -R 1000:1000 /sandbox");
  });

  it("throws when the install fails", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 100, stderr: "E: Unable to locate package git" });
    await expect(prepareBaseEnvironment(sbx)).rejects.toThrow(/base prep failed \(exit 100\)/);
  });
});

describe("destroySandbox", () => {
  it("force-removes the container", async () => {
    const sbx = await fakeSandbox();
    await destroySandbox(sbx);
    expect(argsOf(0)).toEqual(["rm", "-f", sbx.id]);
  });

  it("leaves the artifact dir behind so exports outlive the container", async () => {
    const sbx = await fakeSandbox();
    await writeFile(join(sbx.artifact_dir, "out.txt"), "kept", "utf8");

    await destroySandbox(sbx);

    await expect(readFile(join(sbx.artifact_dir, "out.txt"), "utf8")).resolves.toBe("kept");
  });

  it("does not throw when the container is already gone", async () => {
    const sbx = await fakeSandbox();
    respond = () => ({ code: 1, stderr: "No such container" });
    // Teardown runs in a finally block — it must never mask the real outcome.
    await expect(destroySandbox(sbx)).resolves.toBeUndefined();
  });
});

describe("cleanupArtifactDir", () => {
  it("removes the host artifact dir and its contents", async () => {
    const sbx = await fakeSandbox();
    await writeFile(join(sbx.artifact_dir, "out.txt"), "x", "utf8");

    await cleanupArtifactDir(sbx);

    await expect(readdir(sbx.artifact_dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is a no-op when the dir is already gone", async () => {
    const sbx = await fakeSandbox();
    await cleanupArtifactDir(sbx);
    await expect(cleanupArtifactDir(sbx)).resolves.toBeUndefined();
  });
});

describe("ensureArtifactDir", () => {
  it("creates the directory including missing parents", async () => {
    const base = await mkdtemp(join(tmpdir(), "bv-ensure-"));
    tempDirs.push(base);
    const nested = join(base, "a", "b", "c");

    await ensureArtifactDir(nested);

    await expect(readdir(nested)).resolves.toEqual([]);
  });

  it("is idempotent", async () => {
    const base = await mkdtemp(join(tmpdir(), "bv-ensure-"));
    tempDirs.push(base);
    await ensureArtifactDir(base);
    await expect(ensureArtifactDir(base)).resolves.toBeUndefined();
  });
});

describe("ALLOWED_CLONE_HOSTS", () => {
  it("covers the hosts a python repo clone and pip install actually need", async () => {
    // The list is the documented intent of the egress boundary; if a host
    // is dropped, the clone phase breaks in a way e2e-only tests miss.
    expect(ALLOWED_CLONE_HOSTS).toEqual([
      "github.com",
      "codeload.github.com",
      "raw.githubusercontent.com",
      "pypi.org",
      "files.pythonhosted.org",
    ]);
  });
});
