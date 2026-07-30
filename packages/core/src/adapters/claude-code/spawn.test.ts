import { describe, expect, it } from "vitest";
import { runCliProcess } from "./spawn.js";

// Tests use real subprocesses (echo, node, sleep) rather than mocks because
// the value of spawn.ts is in its process-lifecycle semantics — signal
// handling, pgid, abort/timeout — which you can't verify against a mock.

describe("runCliProcess", () => {
  it.skipIf(process.platform === "win32")(
    "captures stdout from echo with exitCode 0",
    async () => {
      const result = await runCliProcess({
        command: "echo",
        args: ["hello world"],
        cwd: process.cwd(),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello world");
      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(false);
      expect(result.truncated).toBe(false);
      expect(result.pid).toBeGreaterThan(0);
      expect(result.process_group_id).toBe(result.pid);
    },
  );

  it.skipIf(process.platform === "win32")(
    "captures stderr from node -e",
    async () => {
      const result = await runCliProcess({
        command: process.execPath,
        args: ["-e", 'console.error("err-out")'],
        cwd: process.cwd(),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.trim()).toBe("err-out");
    },
  );

  it.skipIf(process.platform === "win32")(
    "pipes stdin to the child",
    async () => {
      const result = await runCliProcess({
        command: process.execPath,
        args: ["-e", "process.stdin.on('data', b => process.stdout.write(b))"],
        cwd: process.cwd(),
        stdin: "piped-payload",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("piped-payload");
    },
  );

  it.skipIf(process.platform === "win32")(
    "non-zero exit code is surfaced",
    async () => {
      const result = await runCliProcess({
        command: process.execPath,
        args: ["-e", "process.exit(42)"],
        cwd: process.cwd(),
      });
      expect(result.exitCode).toBe(42);
      expect(result.aborted).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fires onSpawn with pid + pgid before child exits",
    async () => {
      let spawnMeta: { pid: number; process_group_id: number } | null = null;
      const result = await runCliProcess({
        command: "echo",
        args: ["ok"],
        cwd: process.cwd(),
        onSpawn: (meta) => {
          spawnMeta = meta;
        },
      });
      expect(spawnMeta).not.toBeNull();
      expect(spawnMeta!.pid).toBe(result.pid);
      expect(spawnMeta!.process_group_id).toBe(result.pid);
    },
  );

  it.skipIf(process.platform === "win32")(
    "onLog streams stdout chunks in order",
    async () => {
      const chunks: string[] = [];
      const result = await runCliProcess({
        command: process.execPath,
        args: ["-e", "process.stdout.write('a'); process.stdout.write('b')"],
        cwd: process.cwd(),
        onLog: (stream, chunk) => {
          if (stream === "stdout") chunks.push(chunk);
        },
      });
      expect(result.exitCode).toBe(0);
      expect(chunks.join("")).toBe("ab");
    },
  );

  it.skipIf(process.platform === "win32")(
    "abort signal terminates a long-running child",
    async () => {
      const controller = new AbortController();
      const promise = runCliProcess({
        command: "sleep",
        args: ["30"],
        cwd: process.cwd(),
        abortSignal: controller.signal,
        graceMs: 50,
      });
      setTimeout(() => controller.abort(), 30);
      const result = await promise;
      expect(result.aborted).toBe(true);
      expect(result.timedOut).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "timeoutMs kills the child and reports timedOut",
    async () => {
      const result = await runCliProcess({
        command: "sleep",
        args: ["30"],
        cwd: process.cwd(),
        timeoutMs: 30,
        graceMs: 50,
      });
      expect(result.timedOut).toBe(true);
      expect(result.aborted).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "spawn failure (non-existent command) surfaces error, pid is null",
    async () => {
      let spawnCalled = false;
      const result = await runCliProcess({
        command: "/this/binary/definitely/does/not/exist",
        cwd: process.cwd(),
        onSpawn: () => {
          spawnCalled = true;
        },
      });
      expect(result.pid).toBeNull();
      expect(result.process_group_id).toBeNull();
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toMatch(/ENOENT|no such file/i);
      // onSpawn should NOT fire when pid is null
      expect(spawnCalled).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "truncated flag is set when stdout exceeds 4MB cap",
    async () => {
      // Write ~5MB of 'x' to stdout
      const result = await runCliProcess({
        command: process.execPath,
        args: [
          "-e",
          "const chunk = 'x'.repeat(1024 * 1024); for (let i = 0; i < 5; i++) process.stdout.write(chunk);",
        ],
        cwd: process.cwd(),
      });
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    },
  );
});

// The onLog fast path calls callbacks directly and only switches to a
// serial Promise chain once one actually returns a thenable. Both modes
// must swallow callback failures — a broken log consumer must never take
// the session down — and the async mode must preserve chunk order.
describe("runCliProcess — onLog delivery", () => {
  const emit = (script: string) => ({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
  });

  it.skipIf(process.platform === "win32")(
    "delivers stdout and stderr chunks with their stream kind",
    async () => {
      const seen: Array<[string, string]> = [];
      const result = await runCliProcess({
        ...emit("process.stdout.write('out'); process.stderr.write('err');"),
        onLog: (kind, text) => {
          seen.push([kind, text]);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(seen.some(([k, t]) => k === "stdout" && t.includes("out"))).toBe(true);
      expect(seen.some(([k, t]) => k === "stderr" && t.includes("err"))).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "survives a synchronous onLog that throws",
    async () => {
      let calls = 0;
      const result = await runCliProcess({
        ...emit(
          "for (let i = 0; i < 3; i++) process.stdout.write('chunk' + i + '\\n');",
        ),
        onLog: () => {
          calls++;
          throw new Error("consumer exploded");
        },
      });

      expect(result.exitCode).toBe(0);
      expect(calls).toBeGreaterThan(0);
      expect(result.stdout).toContain("chunk0");
    },
  );

  it.skipIf(process.platform === "win32")(
    "switches to async mode on a thenable and preserves chunk order",
    async () => {
      const order: string[] = [];
      const result = await runCliProcess({
        ...emit(
          // Space the writes out so they arrive as distinct 'data' events.
          "let i = 0; const t = setInterval(() => { process.stdout.write('c' + i + '\\n'); if (++i === 4) clearInterval(t); }, 20);",
        ),
        onLog: async (_kind, text) => {
          // Descending delay: if delivery weren't serialised, later chunks
          // would resolve first and `order` would come out shuffled.
          const n = Number(text.trim().replace("c", "")) || 0;
          await new Promise((r) => setTimeout(r, (4 - n) * 5));
          order.push(text.trim());
        },
      });

      expect(result.exitCode).toBe(0);
      // The first chunk goes through the sync path (nothing to await yet);
      // every chunk after it is serialised through the chain. Needs >1
      // delivery for the ordering claim to mean anything.
      expect(order.length).toBeGreaterThan(1);
      expect(order).toEqual([...order].sort());
    },
  );

  it.skipIf(process.platform === "win32")(
    "survives an onLog whose promise rejects",
    async () => {
      const result = await runCliProcess({
        ...emit(
          "let i = 0; const t = setInterval(() => { process.stdout.write('c' + i + '\\n'); if (++i === 3) clearInterval(t); }, 20);",
        ),
        onLog: async () => {
          throw new Error("async consumer exploded");
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("c0");
    },
  );

  it.skipIf(process.platform === "win32")(
    "survives an onLog that throws only after switching to async mode",
    async () => {
      let calls = 0;
      const result = await runCliProcess({
        ...emit(
          "let i = 0; const t = setInterval(() => { process.stdout.write('c' + i + '\\n'); if (++i === 3) clearInterval(t); }, 20);",
        ),
        onLog: (_kind, text) => {
          calls++;
          // First call returns a thenable (flips asyncMode on); later calls
          // throw synchronously from inside the chain.
          if (calls === 1) return Promise.resolve();
          throw new Error(`sync throw inside chain for ${text}`);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(calls).toBeGreaterThan(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "runs with no onLog configured at all",
    async () => {
      const result = await runCliProcess(emit("process.stdout.write('quiet');"));
      expect(result.stdout).toContain("quiet");
    },
  );
});
