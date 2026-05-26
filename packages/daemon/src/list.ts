/**
 * `beevibe-daemon list` — discover daemon instances on this machine and
 * print one row per instance. Read-only: never writes config.json or
 * anything else under a config root.
 *
 * Discovery is a filesystem scan of $HOME for `.beevibe*` dirs whose
 * `config.json` parses as a beevibe DaemonConfig. Anything that doesn't
 * parse (corrupt JSON, unrelated tool sharing the `.beevibe-*` prefix)
 * is silently skipped — the false-positive rate from "just ship a glob"
 * stays at zero without us needing a registry file.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DaemonConfig } from "./config.js";

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
  /**
   * Best-effort "is the daemon process running" check. Always `"unknown"`
   * today — implementing a non-fragile cross-platform detector would
   * either miss source/tsx runs or false-positive on unrelated processes.
   * Punted to a follow-up.
   */
  running: "unknown";
}

/**
 * Mask a `bv_d_` daemon token for display. The token is an auth
 * credential — show the prefix plus the last 4 chars so two roots can
 * be told apart visually, but never the middle. Same pattern as Stripe
 * keys (`sk_test_…wxyz`) and GitHub PATs in their UI.
 */
function tokenPreview(token: string): string {
  if (!token.startsWith("bv_d_")) return "(invalid)";
  const tail = token.slice("bv_d_".length);
  if (tail.length < 8) return "bv_d_***";
  return `bv_d_…${tail.slice(-4)}`;
}

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
  const cfgPath = join(configRoot, "config.json");
  let raw: string;
  let mtime: Date;
  try {
    raw = readFileSync(cfgPath, "utf8");
    mtime = statSync(cfgPath).mtime;
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isDaemonConfig(parsed)) return undefined;
  return {
    config_root: configRoot,
    daemon_id: parsed.daemon_id,
    api_url: parsed.api_url,
    external_id: parsed.external_id,
    token_preview: tokenPreview(parsed.daemon_token),
    last_sync: mtime.toISOString(),
    running: "unknown",
  };
}

export interface DiscoverOptions {
  /** Override $HOME for testing. */
  home?: string;
}

/**
 * Scan $HOME for `.beevibe*` directories with a parseable daemon
 * config.json. Returns one record per match, sorted by config_root for
 * stable output. Unreadable dirs and non-daemon configs are skipped.
 */
export function discoverDaemons(options: DiscoverOptions = {}): DaemonRecord[] {
  const home = options.home ?? homedir();
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return [];
  }
  const records: DaemonRecord[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(".beevibe")) continue;
    const configRoot = join(home, entry);
    try {
      if (!statSync(configRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    const rec = tryLoad(configRoot);
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
  /** Override $HOME for testing; CLI always uses the real home. */
  home?: string;
}

export function runList(options: ListOptions = {}): void {
  const records = discoverDaemons({ home: options.home });
  console.log(renderList(records, options.json === true));
}
