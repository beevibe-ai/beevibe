/**
 * `beevibe-daemon list` — discover daemon instances on this machine and
 * print one row per instance. Read-only: never writes config.json or
 * anything else under a config root.
 *
 * Discovery is a filesystem scan of $HOME for `.beevibe*` dirs whose
 * `config.json` parses as a beevibe DaemonConfig. Non-matching dirs
 * (corrupt JSON, unrelated tools sharing the prefix) are skipped.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, type DaemonConfig } from "./config.js";

/** Public output shape — one record per discovered daemon. */
export interface DaemonRecord {
  config_root: string;
  daemon_id: string;
  api_url: string;
  external_id: string;
  /** Masked bv_d_ token (prefix + last 4 chars). Never the full secret. */
  token_preview: string;
  /** ISO mtime of <config_root>/config.json. */
  last_sync: string;
  /** Reserved for a future process-detection check; always `"unknown"` today. */
  running: "unknown";
}

function tokenPreview(token: string): string {
  if (!token.startsWith("bv_d_")) return "(invalid)";
  const tail = token.slice("bv_d_".length);
  if (tail.length < 8) return "bv_d_***";
  return `bv_d_…${tail.slice(-4)}`;
}

// loadConfig() does an unchecked `as DaemonConfig` cast — `list` reads
// arbitrary `.beevibe*` dirs (potentially unrelated tools), so the
// shape must be structurally validated before trusting fields.
function isDaemonConfig(x: unknown): x is DaemonConfig {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.api_url === "string" &&
    typeof c.external_id === "string" &&
    typeof c.daemon_id === "string" &&
    typeof c.daemon_token === "string" &&
    Array.isArray(c.runtimes)
  );
}

function tryLoad(configRoot: string): DaemonRecord | undefined {
  let cfg: DaemonConfig | undefined;
  try {
    cfg = loadConfig(configRoot);
  } catch {
    return undefined;
  }
  if (!cfg || !isDaemonConfig(cfg)) return undefined;
  let mtime: Date;
  try {
    mtime = statSync(getConfigPath(configRoot)).mtime;
  } catch {
    return undefined;
  }
  return {
    config_root: configRoot,
    daemon_id: cfg.daemon_id,
    api_url: cfg.api_url,
    external_id: cfg.external_id,
    token_preview: tokenPreview(cfg.daemon_token),
    last_sync: mtime.toISOString(),
    running: "unknown",
  };
}

/**
 * Scan $HOME for `.beevibe*` directories with a parseable daemon
 * config.json. Returns one record per match, sorted by config_root for
 * stable output. Unreadable dirs and non-daemon configs are skipped.
 *
 * `home` exists for tests; the CLI always uses the real `homedir()`.
 */
export function discoverDaemons(home: string = homedir()): DaemonRecord[] {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const records: DaemonRecord[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(".beevibe")) continue;
    if (!entry.isDirectory()) continue;
    const rec = tryLoad(join(home, entry.name));
    if (rec) records.push(rec);
  }
  return records.sort((a, b) => a.config_root.localeCompare(b.config_root));
}

interface Column {
  header: string;
  get: (r: DaemonRecord) => string;
}

const COLUMNS: Column[] = [
  { header: "CONFIG ROOT", get: (r) => r.config_root },
  { header: "DAEMON ID", get: (r) => r.daemon_id },
  { header: "TOKEN", get: (r) => r.token_preview },
  { header: "API", get: (r) => r.api_url },
  { header: "DEVICE", get: (r) => r.external_id },
  { header: "LAST SYNC", get: (r) => r.last_sync },
  { header: "RUNNING", get: (r) => r.running },
];

function formatTable(records: DaemonRecord[]): string {
  const rows = records.map((r) => COLUMNS.map((c) => c.get(r)));
  const widths = COLUMNS.map((c, i) =>
    Math.max(c.header.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const fmt = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const lines = [fmt(COLUMNS.map((c) => c.header))];
  for (const row of rows) lines.push(fmt(row));
  return lines.join("\n");
}

export function renderList(records: DaemonRecord[], json: boolean): string {
  if (json) return JSON.stringify(records, null, 2);
  if (records.length === 0) {
    return "No daemons found. Run `beevibe-daemon setup …` to register one.";
  }
  const count = `${records.length} daemon${records.length === 1 ? "" : "s"} found.`;
  return `${formatTable(records)}\n${count}`;
}

export interface ListOptions {
  json?: boolean;
}

export function runList(options: ListOptions = {}): void {
  console.log(renderList(discoverDaemons(), options.json === true));
}
