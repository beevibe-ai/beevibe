import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export interface CliProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL (default: 20s). */
  graceMs?: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * Fires once after spawn only when pid is non-null. On synchronous spawn
   * failure pid is null and this callback does NOT fire — the promise still
   * resolves so the caller can observe the failure via stderr + pid: null.
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
  /** pgid equals pid for detached Unix processes; null if spawn failed. */
  process_group_id: number | null;
  /** True if stdout or stderr hit MAX_CAPTURE_BYTES. */
  truncated: boolean;
}

/** Accumulates chunks with a size cap. Defers concatenation to `join()` to
 * avoid O(n²) string growth on buffers that are appended in many small pieces. */
class CappedBuffer {
  private readonly chunks: string[] = [];
  private len = 0;
  truncated = false;

  append(chunk: string): void {
    if (this.len >= MAX_CAPTURE_BYTES) {
      this.truncated = true;
      return;
    }
    const remaining = MAX_CAPTURE_BYTES - this.len;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.slice(0, remaining));
      this.len = MAX_CAPTURE_BYTES;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.len += chunk.length;
    }
  }

  join(): string {
    return this.chunks.join("");
  }
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
    const stdout = new CappedBuffer();
    const stderr = new CappedBuffer();
    let settled = false;

    const proc: ChildProcess = spawn(options.command, options.args ?? [], {
      env: (options.env ?? process.env) as NodeJS.ProcessEnv,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      shell: false,
    });

    const pid = proc.pid ?? null;

    if (pid !== null && options.onSpawn) {
      options.onSpawn({ pid, process_group_id: pid });
    }

    function killProc(signal: NodeJS.Signals): void {
      try {
        if (proc.pid) process.kill(-proc.pid, signal);
      } catch {
        // Already dead — ignore.
      }
    }

    function settleWith(partial: Omit<CliProcessResult, "pid" | "process_group_id" | "truncated" | "stdout" | "stderr">): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ...partial,
        stdout: stdout.join(),
        stderr: stderr.join(),
        pid,
        process_group_id: pid,
        truncated: stdout.truncated || stderr.truncated,
      });
    }

    proc.stdin!.on("error", () => {
      /* suppress EPIPE if child closes stdin early */
    });
    if (options.stdin !== undefined) {
      proc.stdin!.write(options.stdin);
    }
    proc.stdin!.end();

    // Most onLog consumers are synchronous — calling them directly avoids
    // a microtask + retained closure per chunk. We only fall back to a
    // serial Promise chain once a callback actually returns a Promise,
    // at which point ordering across async callbacks matters.
    let asyncMode = false;
    let logChain: Promise<unknown> = Promise.resolve();
    function invokeLog(kind: "stdout" | "stderr", text: string): void {
      if (!options.onLog) return;
      const cb = options.onLog;
      if (asyncMode) {
        logChain = logChain
          .then(() => {
            try {
              return cb(kind, text);
            } catch {
              return undefined;
            }
          })
          .catch(() => undefined);
        return;
      }
      let ret: unknown;
      try {
        ret = cb(kind, text);
      } catch {
        return;
      }
      if (ret && typeof (ret as { then?: unknown }).then === "function") {
        asyncMode = true;
        logChain = (ret as Promise<unknown>).catch(() => undefined);
      }
    }
    function attachStreamHandler(stream: Readable, kind: "stdout" | "stderr", buf: CappedBuffer): void {
      stream.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        buf.append(text);
        invokeLog(kind, text);
      });
    }
    attachStreamHandler(proc.stdout!, "stdout", stdout);
    attachStreamHandler(proc.stderr!, "stderr", stderr);

    // The close handler can't know whether exit was clean or forced by
    // abort/timeout — SIGTERM often produces a normal exit code before
    // SIGKILL fires. These flags disambiguate.
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
      settleWith({ exitCode: code, timedOut: timeoutFired, aborted: abortFired });
    });

    proc.on("error", (err) => {
      stderr.append(err.message);
      settleWith({ exitCode: null, timedOut: timeoutFired, aborted: abortFired });
    });
  });
}
