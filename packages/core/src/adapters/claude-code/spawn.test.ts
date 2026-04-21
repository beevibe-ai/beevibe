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
