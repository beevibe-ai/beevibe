import { spawn, type ChildProcess } from "node:child_process";

/**
 * Guarded CLI subprocess runner. Used by `ClaudeCodeRuntime` to spawn the
 * `claude` binary with process-group lifecycle, chunked output capture,
 * abort-signal handling, and graceful shutdown (SIGTERM → grace → SIGKILL).
 *
 * Unix-only: we rely on detached process groups (`process.kill(-pid)`) to
 * ensure the entire CLI child tree dies on abort. Windows has different
 * process semantics and is out of v1 scope — `runCliProcess` throws on
 * win32 rather than silently leaking child processes.
 */

/** Max accumulated stdout/stderr before truncation (4MB). */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export interface CliProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  /**
   * Full env for the child. Caller is responsible for any stripping
   * (e.g. Claude nesting-guard vars belong in ClaudeCodeRuntime, not here —
   * this helper is generic).
   */
  env?: Record<string, string | undefined>;
  /** Pipe this string to stdin once then close. */
  stdin?: string;
  /** Abort signal — sends SIGTERM then SIGKILL after graceMs. */
  abortSignal?: AbortSignal;
  /** Optional hard timeout (no default — runs until done or aborted). */
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL (default: 20s). */
  graceMs?: number;
  /** Streaming callback — fires with each stdout/stderr chunk as it arrives. */
  onLog?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * Fires once after spawn with the OS pid + process-group id. NOT called
   * when spawn fails synchronously (pid === null) — the promise still
   * resolves with pid: null so M5 can detect and skip pid-persistence.
   */
  onSpawn?: (meta: { pid: number; process_group_id: number }) => void;
}

export interface CliProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  pid: number | null;
  /** pgid == pid for detached processes on Unix; null if spawn failed. */
  process_group_id: number | null;
  /** True if stdout or stderr hit the 4MB cap — downstream parsers may be incomplete. */
  truncated: boolean;
}

export function runCliProcess(options: CliProcessOptions): Promise<CliProcessResult> {
  if (process.platform === "win32") {
    throw new Error(
      "runCliProcess: Windows is not supported in v1. Process-group " +
        "signaling is POSIX-only; half-working Windows behavior would leak " +
        "child processes on abort.",
    );
  }

  const graceMs = options.graceMs ?? 20_000;

  return new Promise<CliProcessResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let truncated = false;

    const proc: ChildProcess = spawn(options.command, options.args ?? [], {
      env: (options.env ?? process.env) as NodeJS.ProcessEnv,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // Process group for tree-kill
      shell: false,
    });

    const pid = proc.pid ?? null;
    // pgid equals pid for detached Unix processes (child is the pg leader).
    const processGroupId = pid;

    if (pid !== null && options.onSpawn) {
      options.onSpawn({ pid, process_group_id: processGroupId! });
    }

    function appendCapped(existing: string, chunk: string): string {
      if (existing.length >= MAX_CAPTURE_BYTES) {
        truncated = true;
        return existing;
      }
      const remaining = MAX_CAPTURE_BYTES - existing.length;
      if (chunk.length > remaining) {
        truncated = true;
        return existing + chunk.slice(0, remaining);
      }
      return existing + chunk;
    }

    function killProc(signal: NodeJS.Signals): void {
      try {
        if (proc.pid) process.kill(-proc.pid, signal);
      } catch {
        // Already dead — ignore.
      }
    }

    function settleWith(partial: Omit<CliProcessResult, "pid" | "process_group_id" | "truncated">): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...partial, pid, process_group_id: processGroupId, truncated });
    }

    // stdin
    proc.stdin!.on("error", () => {
      /* suppress EPIPE if child closes stdin early */
    });
    if (options.stdin !== undefined) {
      proc.stdin!.write(options.stdin);
    }
    proc.stdin!.end();

    // Sequential log chain ensures onLog callbacks don't interleave
    let logChain = Promise.resolve();
    proc.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = appendCapped(stdout, text);
      if (options.onLog) {
        const cb = options.onLog;
        logChain = logChain.then(() => {
          try {
            cb("stdout", text);
          } catch {
            /* callback errors don't break execution */
          }
        });
      }
    });
    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = appendCapped(stderr, text);
      if (options.onLog) {
        const cb = options.onLog;
        logChain = logChain.then(() => {
          try {
            cb("stderr", text);
          } catch {
            /* swallow */
          }
        });
      }
    });

    // Outer flags so the `close` handler knows whether exit was caused by
    // abort or timeout. Most children respond to SIGTERM before the SIGKILL
    // grace period fires — without these flags, a clean SIGTERM exit looks
    // like a normal completion.
    let abortFired = false;
    let timeoutFired = false;

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timeoutFired = true;
        killProc("SIGTERM");
        setTimeout(() => {
          if (!settled) killProc("SIGKILL");
        }, graceMs);
      }, options.timeoutMs);
    }

    if (options.abortSignal) {
      options.abortSignal.addEventListener(
        "abort",
        () => {
          abortFired = true;
          killProc("SIGTERM");
          setTimeout(() => {
            if (!settled) killProc("SIGKILL");
          }, graceMs);
        },
        { once: true },
      );
    }

    proc.on("close", (code) => {
      settleWith({
        stdout,
        stderr,
        exitCode: code,
        timedOut: timeoutFired,
        aborted: abortFired,
      });
    });

    proc.on("error", (err) => {
      // Synchronous spawn failures (ENOENT, EACCES, etc.) — pid was never
      // set, so onSpawn did not fire. Resolve with a clear failure.
      settleWith({
        stdout,
        stderr: err.message,
        exitCode: null,
        timedOut: timeoutFired,
        aborted: abortFired,
      });
    });
  });
}
