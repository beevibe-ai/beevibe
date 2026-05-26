import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonConfig } from "./config.js";
import { discoverDaemons, renderList, type DaemonRecord } from "./list.js";

function sampleConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    api_url: "http://localhost:3000",
    external_id: "host.test",
    daemon_id: "dmn_x",
    daemon_token: "bv_d_abcdefgh1234wxyz",
    runtimes: [{ id: "rt_1", cli: "claude" }],
    ...overrides,
  };
}

function writeConfigDir(home: string, dirName: string, cfg: unknown): void {
  const path = join(home, dirName);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "config.json"), JSON.stringify(cfg, null, 2));
}

describe("discoverDaemons", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "beevibe-list-test-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns an empty array when no .beevibe* dir exists", () => {
    expect(discoverDaemons(home)).toEqual([]);
  });

  it("finds a single ~/.beevibe daemon", () => {
    writeConfigDir(home, ".beevibe", sampleConfig({ daemon_id: "dmn_solo" }));
    const records = discoverDaemons(home);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      config_root: join(home, ".beevibe"),
      daemon_id: "dmn_solo",
      api_url: "http://localhost:3000",
      external_id: "host.test",
      running: "unknown",
    });
    // last_sync is an ISO timestamp.
    expect(records[0]?.last_sync).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("finds multiple .beevibe-* daemons and sorts by config_root path", () => {
    writeConfigDir(home, ".beevibe-B", sampleConfig({ daemon_id: "dmn_B" }));
    writeConfigDir(home, ".beevibe-A", sampleConfig({ daemon_id: "dmn_A" }));
    writeConfigDir(home, ".beevibe", sampleConfig({ daemon_id: "dmn_default" }));
    const records = discoverDaemons(home);
    expect(records.map((r) => r.daemon_id)).toEqual([
      "dmn_default",
      "dmn_A",
      "dmn_B",
    ]);
  });

  it("silently skips dirs whose config.json is malformed JSON", () => {
    writeConfigDir(home, ".beevibe", sampleConfig({ daemon_id: "dmn_valid" }));
    const badPath = join(home, ".beevibe-bad");
    mkdirSync(badPath, { recursive: true });
    writeFileSync(join(badPath, "config.json"), "{ not json");
    const records = discoverDaemons(home);
    expect(records.map((r) => r.daemon_id)).toEqual(["dmn_valid"]);
  });

  it("silently skips dirs whose config.json parses but isn't a beevibe daemon config", () => {
    writeConfigDir(home, ".beevibe-other", { unrelated: "tool" });
    expect(discoverDaemons(home)).toEqual([]);
  });

  it("silently skips dirs that have no config.json at all", () => {
    mkdirSync(join(home, ".beevibe-empty"), { recursive: true });
    expect(discoverDaemons(home)).toEqual([]);
  });

  it("ignores entries in $HOME that don't start with .beevibe", () => {
    mkdirSync(join(home, "Documents"), { recursive: true });
    mkdirSync(join(home, ".config"), { recursive: true });
    writeFileSync(join(home, ".bashrc"), "");
    expect(discoverDaemons(home)).toEqual([]);
  });

  it("masks the daemon_token in token_preview and never leaks the secret", () => {
    writeConfigDir(
      home,
      ".beevibe",
      sampleConfig({ daemon_token: "bv_d_supersecretMIDDLEpartXYZ9999" }),
    );
    const [record] = discoverDaemons(home);
    expect(record?.token_preview).toMatch(/^bv_d_/);
    expect(record?.token_preview).not.toContain("supersecret");
    expect(record?.token_preview).not.toContain("MIDDLE");
    // Distinguishing suffix is visible — two tokens are visually distinct.
    expect(record?.token_preview).toContain("9999");
  });

  it("returns [] when $HOME itself is unreadable", () => {
    rmSync(home, { recursive: true, force: true });
    expect(discoverDaemons(home)).toEqual([]);
  });
});

describe("renderList", () => {
  function sampleRecord(overrides: Partial<DaemonRecord> = {}): DaemonRecord {
    return {
      config_root: "/u/.beevibe",
      daemon_id: "dmn_one",
      api_url: "http://localhost:3000",
      external_id: "host.test",
      token_preview: "bv_d_…wxyz",
      last_sync: "2026-05-26T00:00:00.000Z",
      running: "unknown",
      ...overrides,
    };
  }

  it("prints a helpful empty-state message when no daemons", () => {
    const out = renderList([], false);
    expect(out).toMatch(/No daemons found/);
    expect(out).toContain("beevibe-daemon setup");
  });

  it("renders an aligned table with header + footer count for one daemon", () => {
    const out = renderList([sampleRecord()], false);
    expect(out).toContain("CONFIG ROOT");
    expect(out).toContain("DAEMON ID");
    expect(out).toContain("TOKEN");
    expect(out).toContain("RUNNING");
    expect(out).toContain("dmn_one");
    expect(out).toContain("1 daemon found.");
    expect(out).not.toContain("1 daemons");
  });

  it("renders a multi-row table with plural footer", () => {
    const out = renderList(
      [
        sampleRecord({ daemon_id: "dmn_A", config_root: "/u/.beevibe-A" }),
        sampleRecord({ daemon_id: "dmn_B", config_root: "/u/.beevibe-B" }),
      ],
      false,
    );
    expect(out).toContain("dmn_A");
    expect(out).toContain("dmn_B");
    expect(out).toContain("2 daemons found.");
  });

  it("--json output is a valid JSON array of records", () => {
    const out = renderList([sampleRecord()], true);
    const parsed = JSON.parse(out) as DaemonRecord[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(sampleRecord());
  });

  it("--json output is [] when no daemons (parseable by jq)", () => {
    const out = renderList([], true);
    expect(JSON.parse(out)).toEqual([]);
  });
});
