/**
 * `beevibe-daemon update` — self-update for compiled binary installs.
 *
 * Only meaningful when the daemon is running as a Bun-compiled binary
 * (brew install / curl install path). For npm and source installs, the
 * command bails with a hint pointing at the right tool (`npm update -g
 * @beevibe/daemon` or `git pull && pnpm install`).
 *
 * Update flow:
 *   1. Fetch the latest release from GitHub.
 *   2. Compare against the version baked in at compile time.
 *   3. If newer: prompt, then download the matching platform binary,
 *      verify SHA256, atomic-rename over the current binary.
 *   4. Atomic-rename is safe on POSIX — the running process keeps its
 *      inode; the next launch picks up the new binary. We just exit.
 *
 * Per the auto-update plan: we prompt rather than silently install.
 * Surprising binary swaps on a user's machine are hostile.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Baked in by `bun build --compile --define BEEVIBE_DAEMON_VERSION="…"`
// when produced by scripts/build-binaries.sh. The `typeof` guard below is
// what actually keeps tsx / node from throwing ReferenceError when the
// define wasn't applied — declaring as `string` here is just for the
// type-checker.
declare const BEEVIBE_DAEMON_VERSION: string;

const RELEASES_API_URL = "https://api.github.com/repos/beevibe-ai/beevibe/releases/latest";
const DOWNLOAD_BASE = "https://github.com/beevibe-ai/beevibe/releases/download";

interface GitHubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

function currentVersion(): string | undefined {
  return typeof BEEVIBE_DAEMON_VERSION === "string" ? BEEVIBE_DAEMON_VERSION : undefined;
}

function isCompiledBinary(): boolean {
  // Bun-compiled binaries have process.versions.bun set AND
  // process.execPath is the path of the compiled binary. For
  // `bun src/main.ts` it's the path of the Bun runtime itself, and
  // for `node dist/main.js` it ends in `node`. argv[0] is unreliable —
  // Bun rewrites it to the literal string "bun" inside compiled
  // binaries.
  if (!(process.versions as { bun?: string }).bun) return false;
  return !/(bun|node)(?:\.exe)?$/.test(process.execPath);
}

function platformAsset(): string | undefined {
  const arch = process.arch;
  switch (process.platform) {
    case "darwin":
      if (arch === "arm64") return "beevibe-daemon-darwin-arm64";
      if (arch === "x64") return "beevibe-daemon-darwin-x64";
      return undefined;
    case "linux":
      if (arch === "x64") return "beevibe-daemon-linux-x64";
      if (arch === "arm64") return "beevibe-daemon-linux-arm64";
      return undefined;
    default:
      return undefined;
  }
}

function compareSemver(a: string, b: string): number {
  const norm = (s: string): [number, number, number] => {
    const parts = s.replace(/^v/, "").split(".").map((p) => Number.parseInt(p, 10) || 0);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [a1, a2, a3] = norm(a);
  const [b1, b2, b3] = norm(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  const res = await fetch(RELEASES_API_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "beevibe-daemon-updater" },
  });
  // 404 here means "no releases published yet" — treated as "no update
  // available" rather than an error.
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as GitHubRelease;
}

async function downloadBinary(version: string, assetName: string): Promise<Buffer> {
  const url = `${DOWNLOAD_BASE}/${version}/${assetName}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadChecksum(version: string, assetName: string): Promise<string> {
  // The release asset is published alongside a "<asset>.sha256" text file
  // with the format `<hex>  <filename>`.
  const url = `${DOWNLOAD_BASE}/${version}/${assetName}.sha256`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`checksum ${url} failed: ${res.status}`);
  const text = await res.text();
  const hex = text.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`bad checksum format: ${text}`);
  return hex.toLowerCase();
}

function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export async function runUpdate(opts: { skipPrompt?: boolean } = {}): Promise<void> {
  const current = currentVersion();
  if (!current) {
    console.log("Could not determine current daemon version.");
    console.log("If you installed via npm:  npm update -g @beevibe/daemon");
    console.log("If you installed from source: git pull && pnpm install && pnpm build");
    process.exit(2);
  }

  if (!isCompiledBinary()) {
    console.log(`Current version: ${current}`);
    console.log("This binary was not produced by the standalone build path.");
    console.log("If you installed via npm:  npm update -g @beevibe/daemon");
    console.log("If you installed from source: git pull && pnpm install && pnpm build");
    return;
  }

  const asset = platformAsset();
  if (!asset) {
    console.error(`Unsupported platform: ${process.platform}/${process.arch}`);
    console.error("Pre-built binaries are only published for darwin-arm64, darwin-x64, linux-x64, linux-arm64.");
    process.exit(2);
  }

  console.log(`Current version: ${current}`);
  console.log("Checking for updates…");

  const release = await fetchLatestRelease();
  if (!release) {
    console.log("No releases published yet — nothing to update to.");
    return;
  }
  const latest = release.tag_name;
  console.log(`Latest version: ${latest}`);

  if (compareSemver(current, latest) >= 0) {
    console.log("Already on the latest version.");
    return;
  }

  console.log(`Update available: ${current} → ${latest}`);
  if (!opts.skipPrompt) {
    const proceed = await promptYesNo("Install this update now?");
    if (!proceed) {
      console.log("Update cancelled.");
      return;
    }
  }

  console.log(`Downloading ${asset}…`);
  const [binary, expectedSha] = await Promise.all([
    downloadBinary(latest, asset),
    downloadChecksum(latest, asset),
  ]);

  const actualSha = createHash("sha256").update(binary).digest("hex");
  if (actualSha !== expectedSha) {
    console.error(`Checksum mismatch — refusing to install.`);
    console.error(`  expected: ${expectedSha}`);
    console.error(`  actual:   ${actualSha}`);
    process.exit(3);
  }

  const currentBinaryPath = process.execPath;

  const stagingDir = mkdtempSync(join(tmpdir(), "beevibe-daemon-update-"));
  const stagingPath = join(stagingDir, asset);
  writeFileSync(stagingPath, binary);
  chmodSync(stagingPath, 0o755);

  try {
    renameSync(stagingPath, currentBinaryPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to replace ${currentBinaryPath}: ${msg}`);
    console.error(`The new binary is at ${stagingPath} — install manually if needed.`);
    process.exit(3);
  }

  console.log(`Updated to ${latest}. Restart the daemon to pick up the new binary.`);
}
