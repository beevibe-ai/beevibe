import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_ROOT_ENV,
  getConfigPath,
  getConfigRoot,
  isDevBuild,
  loadConfig,
  saveConfig,
  type DaemonConfig,
} from "./config.js";

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

describe("getConfigRoot", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env[CONFIG_ROOT_ENV];
    delete process.env[CONFIG_ROOT_ENV];
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[CONFIG_ROOT_ENV];
    else process.env[CONFIG_ROOT_ENV] = originalEnv;
  });

  it("defaults to ~/.beevibe when no override and no env", () => {
    const root = getConfigRoot();
    expect(root).toMatch(/\.beevibe$/);
  });

  it("BEEVIBE_CONFIG_ROOT env overrides the default", () => {
    process.env[CONFIG_ROOT_ENV] = "/tmp/from-env/.beevibe";
    expect(getConfigRoot()).toBe("/tmp/from-env/.beevibe");
  });

  it("explicit arg overrides both env and default", () => {
    process.env[CONFIG_ROOT_ENV] = "/tmp/from-env/.beevibe";
    expect(getConfigRoot("/tmp/from-flag/.beevibe")).toBe(
      "/tmp/from-flag/.beevibe",
    );
  });

  it("empty-string override falls through to env / default", () => {
    process.env[CONFIG_ROOT_ENV] = "/tmp/from-env/.beevibe";
    expect(getConfigRoot("")).toBe("/tmp/from-env/.beevibe");
  });

  it("getConfigPath returns <root>/config.json", () => {
    expect(getConfigPath("/tmp/x/.beevibe")).toBe("/tmp/x/.beevibe/config.json");
  });
});

describe("loadConfig + saveConfig with configRoot override", () => {
  let tempA: string;
  let tempB: string;

  beforeEach(() => {
    tempA = mkdtempSync(join(tmpdir(), "beevibe-cfg-test-a-"));
    tempB = mkdtempSync(join(tmpdir(), "beevibe-cfg-test-b-"));
  });

  afterEach(() => {
    rmSync(tempA, { recursive: true, force: true });
    rmSync(tempB, { recursive: true, force: true });
  });

  it("save + load round-trip under an explicit configRoot", () => {
    const cfg = sampleConfig({ daemon_token: "bv_d_alpha" });
    saveConfig(cfg, tempA);

    expect(existsSync(join(tempA, "config.json"))).toBe(true);
    const loaded = loadConfig(tempA);
    expect(loaded).toEqual(cfg);
  });

  it("loadConfig returns undefined when the file doesn't exist", () => {
    expect(loadConfig(tempA)).toBeUndefined();
  });

  it("two configRoots are isolated — one save does not affect the other", () => {
    const cfgA = sampleConfig({ daemon_id: "dmn_A", daemon_token: "bv_d_A" });
    const cfgB = sampleConfig({ daemon_id: "dmn_B", daemon_token: "bv_d_B" });

    saveConfig(cfgA, tempA);
    saveConfig(cfgB, tempB);

    expect(loadConfig(tempA)).toEqual(cfgA);
    expect(loadConfig(tempB)).toEqual(cfgB);
  });

  it("config file is written with mode 0600 (credential protection)", () => {
    saveConfig(sampleConfig(), tempA);
    const { mode } = statSync(join(tempA, "config.json"));
    expect((mode & 0o777).toString(8)).toBe("600");
  });

  it("malformed config throws a path-bearing error", () => {
    const path = join(tempA, "config.json");
    mkdirSync(tempA, { recursive: true });
    writeFileSync(path, "not json");
    expect(() => loadConfig(tempA)).toThrow(/malformed/);
    expect(() => loadConfig(tempA)).toThrow(tempA);
  });
});

describe("isDevBuild", () => {
  it("returns true in source / vitest runs (no __DEV_BUILD__ define applied)", () => {
    expect(isDevBuild()).toBe(true);
  });

  it.each([
    { defined: false, expected: false },
    { defined: true, expected: true },
  ])(
    "returns $expected when the bundler set __DEV_BUILD__=$defined",
    ({ defined, expected }) => {
      const g = globalThis as Record<string, unknown>;
      const prev = g.__DEV_BUILD__;
      try {
        g.__DEV_BUILD__ = defined;
        expect(isDevBuild()).toBe(expected);
      } finally {
        if (prev === undefined) delete g.__DEV_BUILD__;
        else g.__DEV_BUILD__ = prev;
      }
    },
  );
});
