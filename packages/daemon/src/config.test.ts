/**
 * Unit coverage for the dev-only config-root override.
 *
 * The flag is the entire surface area of the multi-instance feature:
 * tested against `getConfigRoot` resolution order, `loadConfig` /
 * `saveConfig` round-trip under an override, and the prod-build reject
 * path that main.ts enforces via `isDevBuild()`.
 */
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
  getConfigPath,
  getConfigRoot,
  isDevBuild,
  loadConfig,
  saveConfig,
  type DaemonConfig,
} from "./config.js";

const ENV_KEY = "BEEVIBE_CONFIG_ROOT";

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
    originalEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  it("defaults to ~/.beevibe when no override and no env", () => {
    const root = getConfigRoot();
    expect(root).toMatch(/\.beevibe$/);
  });

  it("BEEVIBE_CONFIG_ROOT env overrides the default", () => {
    process.env[ENV_KEY] = "/tmp/from-env/.beevibe";
    expect(getConfigRoot()).toBe("/tmp/from-env/.beevibe");
  });

  it("explicit arg overrides both env and default", () => {
    process.env[ENV_KEY] = "/tmp/from-env/.beevibe";
    expect(getConfigRoot("/tmp/from-flag/.beevibe")).toBe(
      "/tmp/from-flag/.beevibe",
    );
  });

  it("empty-string override is treated as 'no override' (falls through to env / default)", () => {
    // Same defensive `length > 0` semantics as the WORKSPACE_ROOT
    // fallback in LocalWorkspaceManager — empty-string means "unset",
    // not "use empty path".
    process.env[ENV_KEY] = "/tmp/from-env/.beevibe";
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

    // Reading either root returns only its own config — the multi-account
    // isolation invariant that motivates the whole feature.
    expect(loadConfig(tempA)).toEqual(cfgA);
    expect(loadConfig(tempB)).toEqual(cfgB);
  });

  it("config file is written with mode 0600 (credential protection)", () => {
    saveConfig(sampleConfig(), tempA);
    const path = join(tempA, "config.json");
    const { mode } = statSync(path);
    // POSIX permission bits — strip type bits.
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
  // The runtime guard in main.ts treats isDevBuild() === false as the
  // signal to reject --config-root / BEEVIBE_CONFIG_ROOT. In source/test
  // runs the global is undeclared, so it must be true.
  it("returns true in source / vitest runs (no __DEV_BUILD__ define applied)", () => {
    expect(isDevBuild()).toBe(true);
  });

  it("returns false when a bundler set __DEV_BUILD__=false", () => {
    // Simulate what `bun build --define __DEV_BUILD__=false` does — the
    // identifier becomes a binding in the bundled module. We can't replay
    // the bundler step in a unit test, so install the global manually:
    // `typeof __DEV_BUILD__` resolves to `boolean` and the function reads
    // the value, exercising the false-branch.
    const g = globalThis as Record<string, unknown>;
    const prev = g.__DEV_BUILD__;
    try {
      g.__DEV_BUILD__ = false;
      expect(isDevBuild()).toBe(false);
    } finally {
      if (prev === undefined) delete g.__DEV_BUILD__;
      else g.__DEV_BUILD__ = prev;
    }
  });

  it("returns true when a bundler set __DEV_BUILD__=true (dev distribution)", () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g.__DEV_BUILD__;
    try {
      g.__DEV_BUILD__ = true;
      expect(isDevBuild()).toBe(true);
    } finally {
      if (prev === undefined) delete g.__DEV_BUILD__;
      else g.__DEV_BUILD__ = prev;
    }
  });
});
