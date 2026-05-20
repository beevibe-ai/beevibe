#!/usr/bin/env node
/**
 * Reap orphan sandbox containers from earlier crashed/aborted runs.
 *
 * Usage:
 *   pnpm --filter @beevibe/sandbox exec tsx src/scripts/reap.ts [--older-than-minutes <N>]
 *
 * Default: removes any `bv-run-*` or `bv-sbx-*` / `smoke-*` container
 * older than 30 minutes. Useful in dev when Docker piles up after
 * a failed orchestrator run or a force-quit Next.js dev server.
 */
import { spawn } from "node:child_process";

interface Args {
  olderThanMinutes: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let olderThanMinutes = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--older-than-minutes" && args[i + 1]) {
      const n = Number(args[i + 1]);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`bad --older-than-minutes value: ${args[i + 1]}`);
      }
      olderThanMinutes = n;
      i++;
    }
  }
  return { olderThanMinutes };
}

async function docker(args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    proc.on("close", (code) => resolve({ stdout, code: code ?? -1 }));
    proc.on("error", () => resolve({ stdout, code: -1 }));
  });
}

async function main(): Promise<void> {
  const { olderThanMinutes } = parseArgs();
  const cutoffMs = Date.now() - olderThanMinutes * 60 * 1000;

  const { stdout, code } = await docker([
    "ps",
    "-a",
    "--format",
    "{{.Names}}\t{{.CreatedAt}}",
  ]);
  if (code !== 0) {
    process.stderr.write("docker ps failed — is Docker running?\n");
    process.exit(1);
  }

  const candidates: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [name, createdAt] = line.split("\t");
    if (!name || !createdAt) continue;
    if (!/^(bv-(run|sbx)-|smoke-)/.test(name)) continue;
    const created = new Date(createdAt).getTime();
    if (!Number.isFinite(created)) continue;
    if (created < cutoffMs) candidates.push(name);
  }

  if (candidates.length === 0) {
    process.stdout.write(`No orphan sandbox containers older than ${olderThanMinutes} min.\n`);
    return;
  }

  process.stdout.write(`Reaping ${candidates.length} container(s):\n`);
  for (const name of candidates) {
    process.stdout.write(`  - ${name}\n`);
  }
  const r = await docker(["rm", "-f", ...candidates]);
  if (r.code !== 0) {
    process.stderr.write(`docker rm failed: ${r.stdout}\n`);
    process.exit(1);
  }
  process.stdout.write("done.\n");
}

main().catch((err) => {
  process.stderr.write(`reap failed: ${err.message ?? err}\n`);
  process.exit(1);
});
