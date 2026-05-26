/**
 * `beevibe-daemon list` — discover daemon instances on this machine and
 * print a row per instance. Read-only: never writes to any config.json
 * or workspace dir.
 *
 * Discovery: filesystem glob of `$HOME/.beevibe*` for dirs containing a
 * `config.json` that parses as a `DaemonConfig`. Dirs whose JSON doesn't
 * have the required daemon fields are silently skipped.
 *
 * Running check: best-effort `ps` scan for `beevibe-daemon start`
 * processes whose argv includes `--config-root <root>`. A daemon
 * launched purely via the `BEEVIBE_CONFIG_ROOT` env var won't be
 * detected — env vars don't show up in `ps` output. That case falls
 * through to `running="unknown"` rather than guessing.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DaemonConfig } from "./config.js";
import { getConfigRoot } from "./config.js";

const execFileAsync = promisify(execFile);

export interface DaemonInstance {
  config_root: string;
  daemon_id: string;
  external_id: string;
  api_url: string;
  runtimes: number;
  running: boolean | "unknown";
  last_sync: string;
}

export interface ListOptions {
  home?: string;
  /** `undefined` → live `ps` probe; `null` → skip probe entirely; string → parse as if it were ps output. Test injection. */
  psOutput?: string | null;
}

export interface ListResult {
  instances: DaemonInstance[];
}

function isDaemonConfig(value: unknown): value is DaemonConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.api_url === "string" &&
    typeof v.external_id === "string" &&
    typeof v.daemon_id === "string" &&
    typeof v.daemon_token === "string" &&
    Array.isArray(v.runtimes)
  );
}

function tryLoad(configRoot: string): DaemonConfig | undefined {
  try {
    const raw = readFileSync(join(configRoot, "config.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isDaemonConfig(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Match the daemon's executable token followed by its args. Covers the
// three real launch shapes: compiled binary (`beevibe-daemon`), npm
// bundle (`node .../@beevibe/daemon/dist/main.js`), and tsx/tsc dev
// (`node .../packages/daemon/(src|dist)/main.(ts|js)`). Requiring the
// binary token keeps the bare word "daemon" inside another tool's argv
// (e.g. a long `--append-system-prompt` payload that mentions "daemon")
// from being matched.
const BINARY_PATTERN =
  /(?:beevibe-daemon|daemon\/(?:src|dist)\/main\.(?:ts|js)|@beevibe\/daemon\/dist\/main\.js)\s+([^\n]*)/;

function parseRunningRoots(psOutput: string, defaultRoot: string): Set<string> {
  const running = new Set<string>();
  for (const line of psOutput.split("\n")) {
    const m = BINARY_PATTERN.exec(line);
    if (!m || !m[1]) continue;
    if (!/^\s*start\b/.test(m[1])) continue;
    const cfg = /--config-root[= ]([^\s]+)/.exec(m[1]);
    running.add(cfg && cfg[1] ? cfg[1] : defaultRoot);
  }
  return running;
}

async function probePsRunningRoots(): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,args="], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseRunningRoots(stdout, getConfigRoot());
  } catch {
    return null;
  }
}

export async function runList(options: ListOptions = {}): Promise<ListResult> {
  const home = options.home ?? homedir();
  let entries: string[] = [];
  try {
    entries = readdirSync(home);
  } catch {
    return { instances: [] };
  }

  const candidates = entries
    .filter((name) => name === ".beevibe" || name.startsWith(".beevibe-"))
    .map((name) => join(home, name));

  const running =
    options.psOutput === undefined
      ? await probePsRunningRoots()
      : options.psOutput === null
        ? null
        : parseRunningRoots(options.psOutput, getConfigRoot());

  const instances: DaemonInstance[] = [];
  for (const root of candidates) {
    const cfg = tryLoad(root);
    if (!cfg) continue;
    let lastSync = "";
    try {
      lastSync = statSync(join(root, "config.json")).mtime.toISOString();
    } catch {
      continue;
    }
    instances.push({
      config_root: root,
      daemon_id: cfg.daemon_id,
      external_id: cfg.external_id,
      api_url: cfg.api_url,
      runtimes: cfg.runtimes.length,
      running: running === null ? "unknown" : running.has(root),
      last_sync: lastSync,
    });
  }

  instances.sort((a, b) => a.config_root.localeCompare(b.config_root));
  return { instances };
}

function shortenHome(path: string, home: string): string {
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

function relativeTime(iso: string, now: number = Date.now()): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "unknown";
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

export function formatTable(
  result: ListResult,
  home: string = homedir(),
  now: number = Date.now(),
): string {
  if (result.instances.length === 0) return "No beevibe daemons found under $HOME.";
  const rows = result.instances.map((d) => [
    shortenHome(d.config_root, home),
    d.daemon_id,
    d.external_id,
    d.api_url,
    d.running === "unknown" ? "unknown" : d.running ? "yes" : "no",
    relativeTime(d.last_sync, now),
  ]);
  const header = ["CONFIG_ROOT", "DAEMON_ID", "EXTERNAL_ID", "API_URL", "RUNNING", "LAST_SYNC"];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const pad = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const count = result.instances.length;
  return [
    pad(header),
    ...rows.map(pad),
    "",
    `${count} daemon${count === 1 ? "" : "s"} found.`,
  ].join("\n");
}

export function formatJson(result: ListResult): string {
  return JSON.stringify(result.instances, null, 2);
}
