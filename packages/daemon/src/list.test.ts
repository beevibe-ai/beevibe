import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig, type DaemonConfig } from "./config.js";
import { formatJson, formatTable, runList } from "./list.js";

function sampleConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    api_url: "http://localhost:3000",
    external_id: "host.test",
    daemon_id: "dmn_test",
    daemon_token: "bv_d_test",
    runtimes: [{ id: "rt_test", cli: "claude" }],
    ...overrides,
  };
}

describe("runList", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "beevibe-list-test-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns an empty list when there are no .beevibe* dirs", async () => {
    const result = await runList({ home, psOutput: null });
    expect(result.instances).toEqual([]);
  });

  it("returns a single daemon when only ~/.beevibe exists", async () => {
    const root = join(home, ".beevibe");
    saveConfig(sampleConfig({ daemon_id: "dmn_only" }), root);

    const result = await runList({ home, psOutput: null });
    expect(result.instances).toHaveLength(1);
    const [only] = result.instances;
    expect(only?.daemon_id).toBe("dmn_only");
    expect(only?.config_root).toBe(root);
    expect(only?.running).toBe("unknown");
  });

  it("returns two daemons when both ~/.beevibe-A and ~/.beevibe-B exist (sorted)", async () => {
    const rootA = join(home, ".beevibe-A");
    const rootB = join(home, ".beevibe-B");
    saveConfig(sampleConfig({ daemon_id: "dmn_A" }), rootA);
    saveConfig(sampleConfig({ daemon_id: "dmn_B" }), rootB);

    const result = await runList({ home, psOutput: null });
    expect(result.instances).toHaveLength(2);
    expect(result.instances.map((d) => d.daemon_id)).toEqual(["dmn_A", "dmn_B"]);
  });

  it("silently skips dirs with a malformed config.json", async () => {
    const valid = join(home, ".beevibe");
    saveConfig(sampleConfig({ daemon_id: "dmn_valid" }), valid);

    const garbage = join(home, ".beevibe-garbage");
    mkdirSync(garbage, { recursive: true });
    writeFileSync(join(garbage, "config.json"), "not json");

    const result = await runList({ home, psOutput: null });
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]?.daemon_id).toBe("dmn_valid");
  });

  it("skips dirs whose config.json parses but lacks daemon fields", async () => {
    const unrelated = join(home, ".beevibe-someone-elses-app");
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(
      join(unrelated, "config.json"),
      JSON.stringify({ unrelated: true, foo: "bar" }),
    );

    const result = await runList({ home, psOutput: null });
    expect(result.instances).toEqual([]);
  });

  it("skips .beevibe* dirs with no config.json at all (workspaces / skills caches)", async () => {
    const noConfig = join(home, ".beevibe-empty");
    mkdirSync(noConfig, { recursive: true });

    const result = await runList({ home, psOutput: null });
    expect(result.instances).toEqual([]);
  });

  it("reports running=true when ps output mentions the matching --config-root", async () => {
    const rootA = join(home, ".beevibe-A");
    const rootB = join(home, ".beevibe-B");
    saveConfig(sampleConfig({ daemon_id: "dmn_A" }), rootA);
    saveConfig(sampleConfig({ daemon_id: "dmn_B" }), rootB);

    const psOutput = [
      `12345 beevibe-daemon start --config-root ${rootA}`,
      "67890 some-other-process foo bar",
    ].join("\n");

    const result = await runList({ home, psOutput });
    const a = result.instances.find((d) => d.config_root === rootA);
    const b = result.instances.find((d) => d.config_root === rootB);
    expect(a?.running).toBe(true);
    expect(b?.running).toBe(false);
  });

  it("matches source-dev paths (e.g. tsx packages/daemon/src/main.ts)", async () => {
    const rootA = join(home, ".beevibe-A");
    saveConfig(sampleConfig(), rootA);
    const psOutput = `99 node /repo/packages/daemon/src/main.ts start --config-root ${rootA}`;
    const result = await runList({ home, psOutput });
    expect(result.instances[0]?.running).toBe(true);
  });

  it("ignores lines where 'daemon' / 'start' appear inside another tool's argv", async () => {
    const root = join(home, ".beevibe");
    saveConfig(sampleConfig(), root);
    // A long --append-system-prompt payload that happens to mention
    // both 'daemon' and 'start' — must not be misread as a running
    // beevibe-daemon under the default root.
    const psOutput =
      "555 claude --print --append-system-prompt the daemon will start polling on heartbeat";
    const result = await runList({ home, psOutput });
    expect(result.instances[0]?.running).toBe(false);
  });

  it("ignores 'beevibe-daemon list' / 'sync' / 'setup' — only `start` counts", async () => {
    const root = join(home, ".beevibe");
    saveConfig(sampleConfig(), root);
    const psOutput = `123 beevibe-daemon list --json`;
    const result = await runList({ home, psOutput });
    expect(result.instances[0]?.running).toBe(false);
  });

  it("populates last_sync as an ISO timestamp", async () => {
    const root = join(home, ".beevibe");
    saveConfig(sampleConfig(), root);
    const result = await runList({ home, psOutput: null });
    expect(result.instances[0]?.last_sync).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});

describe("formatJson", () => {
  it("emits valid JSON parseable as an array", () => {
    const out = formatJson({
      instances: [
        {
          config_root: "/tmp/.beevibe-A",
          daemon_id: "dmn_A",
          external_id: "host.A",
          api_url: "http://localhost:3000",
          runtimes: 1,
          running: true,
          last_sync: "2026-05-25T10:00:00.000Z",
        },
      ],
    });
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      config_root: "/tmp/.beevibe-A",
      daemon_id: "dmn_A",
      running: true,
    });
  });

  it("emits [] for the empty case", () => {
    expect(formatJson({ instances: [] })).toBe("[]");
  });
});

describe("formatTable", () => {
  it("shows the no-daemons-found message on empty input", () => {
    expect(formatTable({ instances: [] })).toMatch(/No beevibe daemons/);
  });

  it("renders a header + row + count for one daemon", () => {
    const out = formatTable(
      {
        instances: [
          {
            config_root: "/Users/me/.beevibe",
            daemon_id: "dmn_X",
            external_id: "macbook.local",
            api_url: "http://localhost:3000",
            runtimes: 1,
            running: true,
            last_sync: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          },
        ],
      },
      "/Users/me",
    );
    expect(out).toContain("CONFIG_ROOT");
    expect(out).toContain("DAEMON_ID");
    expect(out).toContain("~/.beevibe");
    expect(out).toContain("dmn_X");
    expect(out).toContain("1 daemon found.");
  });

  it("singular vs plural in the footer", () => {
    const make = (n: number): string =>
      formatTable({
        instances: Array.from({ length: n }, (_, i) => ({
          config_root: `/x/.beevibe-${i}`,
          daemon_id: `dmn_${i}`,
          external_id: "h",
          api_url: "u",
          runtimes: 0,
          running: false as const,
          last_sync: new Date().toISOString(),
        })),
      });
    expect(make(1)).toContain("1 daemon found.");
    expect(make(2)).toContain("2 daemons found.");
  });
});
