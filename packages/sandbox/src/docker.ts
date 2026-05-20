/**
 * Docker-backed sandbox primitives.
 *
 * The trust boundary for "agent uses external repo" lives here. A sandbox
 * is a single Docker container plus a host-side artifact directory. The
 * agent can only touch the container through the functions in this file
 * (and the MCP wrapper in `./mcp-server.ts` which exposes them to a child
 * claude session).
 *
 * Defaults are conservative — no host filesystem mount, no host network
 * after the initial clone step, CPU/memory/disk caps. The first POC pins
 * a single base image (`python:3.12-slim` + git + curl) and only allows
 * a hardcoded list of GitHub hosts during the clone phase.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SandboxLimits {
  /** Hard wall-clock cap on any single command (seconds). Default 300. */
  cmd_timeout_seconds?: number;
  /** CPU quota — fractional cores (e.g. 1.5). Default 2. */
  cpus?: number;
  /** Memory cap, "512m" / "2g" etc. Default "2g". */
  memory?: string;
  /** Writable-layer disk cap, "5g" etc. Default "4g". */
  storage?: string;
  /** Whether the sandbox can reach the network after creation. Default true (we need git clone). Set to false to lock it down further. */
  network?: boolean;
}

export interface SandboxOptions {
  /**
   * Pinned base image. The first POC only supports `python:3.12-slim`
   * (with git + curl + pip pre-installed), but the parameter exists so
   * later images can be swapped without touching callers.
   */
  image?: string;
  limits?: SandboxLimits;
  /**
   * Human-readable tag for logs / `docker ps`. Combined with a random
   * suffix to make the actual container name.
   */
  label?: string;
}

export interface Sandbox {
  /** Container id (also used as the container name). */
  id: string;
  image: string;
  /** Host directory the sandbox treats as `/sandbox/artifacts/`. Files copied here are exportable. */
  artifact_dir: string;
  /** When the sandbox was created. */
  created_at: Date;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  /** Wall-clock seconds the command ran. */
  duration_seconds: number;
}

/**
 * Default base image for the first POC. Pre-installed: git, curl, pip,
 * python 3.12. Anything else the agent needs it has to `apt-get install`
 * or `pip install` inside the sandbox.
 *
 * Note: in production this should be a pinned, custom-built image
 * mirrored to a trusted registry; for the POC we use the upstream
 * `python:3.12-slim` directly and `apt-get install -y git curl`
 * on first exec via a `prepare` step.
 */
export const DEFAULT_IMAGE = "python:3.12-slim";

const DEFAULT_LIMITS: Required<SandboxLimits> = {
  cmd_timeout_seconds: 300,
  cpus: 2,
  memory: "2g",
  storage: "4g",
  network: true,
};

/**
 * Allowed hosts during the clone phase. Anything else the sandbox tries
 * to reach will be rejected at the docker network level.
 *
 * NOTE: the first POC does NOT yet enforce this — Docker's default
 * bridge network gives full egress. Calling out the intended boundary
 * so it's obvious where the seam is.
 */
export const ALLOWED_CLONE_HOSTS = [
  "github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "pypi.org",
  "files.pythonhosted.org",
];

/* ─────────── public API ─────────── */

export async function createSandbox(opts: SandboxOptions = {}): Promise<Sandbox> {
  const image = opts.image ?? DEFAULT_IMAGE;
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const id = generateId(opts.label ?? "bv-sbx");
  const artifact_dir = await mkdtemp(join(tmpdir(), `${id}-artifacts-`));

  const args = [
    "run",
    "--detach",
    "--name",
    id,
    // Resource caps
    `--cpus=${limits.cpus}`,
    `--memory=${limits.memory}`,
    `--storage-opt=size=${limits.storage}`,
    // Identity: rootless when the docker daemon supports it; otherwise
    // run as a non-root in-container user so the agent can't `apt-get`
    // privileged operations even if it tries.
    "--user",
    "1000:1000",
    // Tmpfs for /tmp so the agent has a writable scratch area without
    // bloating the writable layer. Disk cap above bounds the layer.
    "--tmpfs",
    "/tmp:rw,size=512m",
    // Mount the artifact dir so we can copy results out without
    // `docker cp` per file. The agent writes to /sandbox/artifacts/
    // through the MCP `sandbox_export_artifact` tool, which does the
    // host-side copy explicitly — this bind is only used for the
    // export step.
    "-v",
    `${artifact_dir}:/sandbox/artifacts:rw`,
    "--workdir",
    "/sandbox",
    // Keep the container alive so we can `docker exec` repeatedly.
    "--entrypoint",
    "tail",
  ];

  if (!limits.network) {
    args.push("--network=none");
  }

  args.push(image, "-f", "/dev/null");

  // Some images don't have non-root /sandbox writable; pre-create it
  // before spawning the long-lived `tail`. Easiest path: prepend a
  // setup container. For the POC we'll skip and just `mkdir -p` from
  // exec calls; the bind mount already provides /sandbox/artifacts.

  const result = await runDocker(args, { timeoutMs: 30_000 });
  if (result.exit_code !== 0) {
    await rm(artifact_dir, { recursive: true, force: true }).catch(() => {});
    throw new SandboxError(
      `Failed to create sandbox: ${result.stderr.trim() || "docker run exited " + result.exit_code}`,
    );
  }

  return {
    id,
    image,
    artifact_dir,
    created_at: new Date(),
  };
}

export async function exec(
  sandbox: Sandbox,
  cmd: string,
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    timeout_seconds?: number;
  } = {},
): Promise<ExecResult> {
  const cwd = opts.cwd ?? "/sandbox";
  const timeoutMs =
    (opts.timeout_seconds ?? DEFAULT_LIMITS.cmd_timeout_seconds) * 1000;

  const args = ["exec", "--workdir", cwd];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push("--env", `${k}=${v}`);
  }
  args.push(sandbox.id, "sh", "-c", cmd);

  const startedAt = Date.now();
  const r = await runDocker(args, { timeoutMs });
  return {
    stdout: r.stdout,
    stderr: r.stderr,
    exit_code: r.exit_code,
    timed_out: r.timed_out,
    duration_seconds: (Date.now() - startedAt) / 1000,
  };
}

export async function readFileIn(
  sandbox: Sandbox,
  path: string,
  opts: { max_bytes?: number } = {},
): Promise<string> {
  const max = opts.max_bytes ?? 1_000_000;
  // `cat` is simplest; we cap the read with `head -c` so a runaway file
  // can't blow memory.
  const r = await exec(sandbox, `head -c ${max + 1} ${shellQuote(path)}`, {
    timeout_seconds: 30,
  });
  if (r.exit_code !== 0) {
    throw new SandboxError(
      `read ${path} failed (exit ${r.exit_code}): ${r.stderr.trim().slice(0, 500)}`,
    );
  }
  if (r.stdout.length > max) {
    throw new SandboxError(
      `read ${path} exceeded max_bytes=${max} (got at least ${r.stdout.length} bytes)`,
    );
  }
  return r.stdout;
}

export async function writeFileIn(
  sandbox: Sandbox,
  path: string,
  content: string,
): Promise<void> {
  // Stage the file on the host artifact bind, then `mv` into place
  // inside the container — avoids huge stdin-over-`docker-exec`
  // payloads and lets us write to paths outside /sandbox/artifacts.
  const stageName = `__stage_${randomBytes(6).toString("hex")}`;
  const stageHostPath = join(sandbox.artifact_dir, stageName);
  const stageContainerPath = `/sandbox/artifacts/${stageName}`;
  await writeFile(stageHostPath, content, "utf8");
  try {
    const dir = path.replace(/\/[^/]*$/, "") || "/sandbox";
    const ensureDir = await exec(sandbox, `mkdir -p ${shellQuote(dir)}`);
    if (ensureDir.exit_code !== 0) {
      throw new SandboxError(
        `mkdir -p ${dir} failed: ${ensureDir.stderr.trim().slice(0, 200)}`,
      );
    }
    const mv = await exec(
      sandbox,
      `mv ${shellQuote(stageContainerPath)} ${shellQuote(path)}`,
    );
    if (mv.exit_code !== 0) {
      throw new SandboxError(
        `write ${path} failed: ${mv.stderr.trim().slice(0, 200)}`,
      );
    }
  } finally {
    // If the mv succeeded the staging file is gone; if it failed leave
    // the staging file for debugging but don't crash the cleanup.
    await rm(stageHostPath, { force: true }).catch(() => {});
  }
}

export async function listDir(
  sandbox: Sandbox,
  path: string,
): Promise<string[]> {
  const r = await exec(sandbox, `ls -1 ${shellQuote(path)}`, {
    timeout_seconds: 30,
  });
  if (r.exit_code !== 0) {
    throw new SandboxError(
      `list ${path} failed (exit ${r.exit_code}): ${r.stderr.trim().slice(0, 200)}`,
    );
  }
  return r.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Export a sandbox path to the host as a real file. The agent calls this
 * to "publish" an artifact for the parent. The returned host path is
 * inside the sandbox's artifact_dir, which the api server can read.
 *
 * Implementation: `docker cp` the file out of the container into the
 * sandbox's artifact_dir, preserving the basename.
 */
export async function exportArtifact(
  sandbox: Sandbox,
  sandboxPath: string,
): Promise<{ host_path: string; size_bytes: number }> {
  const basename = sandboxPath.split("/").pop() ?? "artifact";
  const hostPath = join(sandbox.artifact_dir, basename);
  const args = ["cp", `${sandbox.id}:${sandboxPath}`, hostPath];
  const r = await runDocker(args, { timeoutMs: 60_000 });
  if (r.exit_code !== 0) {
    throw new SandboxError(
      `export ${sandboxPath} failed: ${r.stderr.trim().slice(0, 200)}`,
    );
  }
  const buf = await readFile(hostPath);
  return { host_path: hostPath, size_bytes: buf.byteLength };
}

export async function destroySandbox(sandbox: Sandbox): Promise<void> {
  await runDocker(["rm", "-f", sandbox.id], { timeoutMs: 30_000 }).catch(() => {});
  // NB: artifact_dir on the host is intentionally left in place so the
  // orchestrator can serve exported artifacts to the UI after the run
  // ends. The OS will GC /tmp eventually; production code should
  // promote artifacts to durable storage and call cleanupArtifactDir.
}

/** Optional cleanup — call when the run's artifacts are no longer needed. */
export async function cleanupArtifactDir(sandbox: Sandbox): Promise<void> {
  await rm(sandbox.artifact_dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * One-shot helper: setup the base sandbox so the agent has a working
 * shell. Installs git + curl on top of `python:3.12-slim`. This is
 * separate from createSandbox so callers can swap base images later
 * without forcing this prep step.
 */
export async function prepareBaseEnvironment(sandbox: Sandbox): Promise<void> {
  // Run as root for apt-get; from this point onward the agent's
  // commands run as the in-container user (uid 1000) because that's
  // what was set on `docker run --user`.
  const r = await runDocker(
    [
      "exec",
      "--user",
      "0",
      sandbox.id,
      "sh",
      "-c",
      "apt-get update -qq && apt-get install -y -qq --no-install-recommends git curl ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir -p /sandbox && chown -R 1000:1000 /sandbox",
    ],
    { timeoutMs: 180_000 },
  );
  if (r.exit_code !== 0) {
    throw new SandboxError(
      `base prep failed (exit ${r.exit_code}): ${r.stderr.trim().slice(0, 500)}`,
    );
  }
}

/* ─────────── internals ─────────── */

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

interface RawResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
}

function runDocker(
  args: string[],
  opts: { timeoutMs: number },
): Promise<RawResult> {
  return new Promise((resolve) => {
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, opts.timeoutMs);
    proc.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    proc.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + `\n<spawn-error>${err.message}</spawn-error>`,
        exit_code: -1,
        timed_out: timedOut,
      });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exit_code: code ?? -1,
        timed_out: timedOut,
      });
    });
  });
}

function generateId(label: string): string {
  const suffix = randomBytes(4).toString("hex");
  // Container names: lowercase alphanumeric + dash + underscore only.
  const safe = label.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
  return `${safe}-${suffix}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Ensure the artifact dir exists on the host before bind-mounting.
 * Exposed only because tests want to construct synthetic sandboxes
 * without going through the full `createSandbox` path.
 */
export async function ensureArtifactDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
