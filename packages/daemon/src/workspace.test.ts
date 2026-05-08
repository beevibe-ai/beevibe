import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provisionWorkspace } from "./workspace.js";

// Provision under a tmpdir so the test doesn't pollute ~/.beevibe.
function withTmpHome<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "beevibe-daemon-test-"));
  const prevHome = process.env.HOME;
  process.env.HOME = root;
  try {
    return fn(root);
  } finally {
    process.env.HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("provisionWorkspace", () => {
  it("creates the agent's workspace dir + writes mcp-config.json with the bv_a_ token", () => {
    withTmpHome((root) => {
      const ws = provisionWorkspace({
        agentId: "agent_42",
        agentApiKey: "bv_a_test123",
        mcpServerUrl: "http://api.test/mcp",
      });
      expect(ws.path).toBe(join(root, ".beevibe", "workspaces", "agent_42"));
      expect(existsSync(ws.path)).toBe(true);
      const cfg = JSON.parse(
        readFileSync(join(ws.path, "mcp-config.json"), "utf8"),
      );
      expect(cfg.mcpServers.beevibe.url).toBe("http://api.test/mcp");
      expect(cfg.mcpServers.beevibe.headers.Authorization).toBe("Bearer bv_a_test123");
      expect(cfg.mcpServers.beevibe.headers["X-Beevibe-Session"]).toBe(
        "${BEEVIBE_SESSION_ID}",
      );
    });
  });

  it("rewrites mcp-config.json on each call so token rotations land immediately", () => {
    withTmpHome((root) => {
      provisionWorkspace({
        agentId: "agent_42",
        agentApiKey: "bv_a_first",
        mcpServerUrl: "http://api.test/mcp",
      });
      const cfgPath = join(root, ".beevibe", "workspaces", "agent_42", "mcp-config.json");
      provisionWorkspace({
        agentId: "agent_42",
        agentApiKey: "bv_a_second",
        mcpServerUrl: "http://api.test/mcp",
      });
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      expect(cfg.mcpServers.beevibe.headers.Authorization).toBe("Bearer bv_a_second");
    });
  });
});
