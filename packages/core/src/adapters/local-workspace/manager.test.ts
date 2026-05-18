import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "../../domain/agent.js";
import type { AgentRuntime, RuntimeRegistry, Workspace } from "../../ports/runtime.js";
import { LocalWorkspaceManager } from "./manager.js";

const MCP_URL = "http://mcp.example/";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_abc",
    name: "Test Agent",
    owner_id: "person_owner",
    hierarchy_level: "ic",
    api_key: "bv_a_testkey123",
    runtime_config: { type: "claude", model: "claude-opus-4-7" },
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// Fake claude-code runtime — only `skillsDir` and `type` are exercised here.
const fakeClaudeRuntime = {
  type: "claude",
  skillsDir: (workspace: Workspace) => join(workspace.path, ".claude", "skills"),
} as unknown as AgentRuntime;
const fakeRuntimeRegistry: RuntimeRegistry = { "claude": fakeClaudeRuntime };

describe("LocalWorkspaceManager", () => {
  let workspaceRoot: string;
  let skillsSourceDir: string;
  let manager: LocalWorkspaceManager;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "beevibe-ws-test-"));
    // Empty skills source dir by default; specific tests populate it.
    skillsSourceDir = mkdtempSync(join(tmpdir(), "beevibe-skills-src-"));
    manager = new LocalWorkspaceManager({
      workspaceRoot,
      mcpServerUrl: MCP_URL,
      runtimeRegistry: fakeRuntimeRegistry,
      skillsSourceDir,
    });
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(skillsSourceDir, { recursive: true, force: true });
  });

  it("ensureWorkspace creates the agent dir under workspaceRoot", async () => {
    const ws = await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_abc" }) });
    expect(ws.path).toBe(join(workspaceRoot, "agent_abc"));
    expect(existsSync(ws.path)).toBe(true);
    expect(statSync(ws.path).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "dir is created with 0o700 (user-only) permissions",
    async () => {
      const ws = await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_perms" }) });
      const mode = statSync(ws.path).mode & 0o777;
      expect(mode).toBe(0o700);
    },
  );

  it("ensureWorkspace is idempotent: second call returns same path, doesn't error", async () => {
    const ws1 = await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_idem" }) });
    const ws2 = await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_idem" }) });
    expect(ws2.path).toBe(ws1.path);
  });

  it("ensureWorkspace preserves existing files inside the dir (persistence)", async () => {
    const ws = await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_persist" }) });
    writeFileSync(join(ws.path, "notes.md"), "# notes\n");
    writeFileSync(join(ws.path, "cloned-repo.txt"), "repo data");

    await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_persist" }) });

    const files = readdirSync(ws.path).sort();
    // mcp-config.json was written on first ensure; preserved along with the user-created
    // files. .claude/ is created by M9.3 skill sync (empty when sourceDir has no skills).
    expect(files).toEqual([".claude", "cloned-repo.txt", "mcp-config.json", "notes.md"]);
  });

  it("recursive mkdir creates missing parent dirs", async () => {
    const deepRoot = join(workspaceRoot, "nested", "deeper");
    const deepManager = new LocalWorkspaceManager({
      workspaceRoot: deepRoot,
      mcpServerUrl: MCP_URL,
      runtimeRegistry: fakeRuntimeRegistry,
      skillsSourceDir,
    });
    const ws = await deepManager.ensureWorkspace({ agent: makeAgent({ id: "agent_deep" }) });
    expect(existsSync(ws.path)).toBe(true);
    expect(ws.path).toBe(join(deepRoot, "agent_deep"));
  });

  it("defaults workspaceRoot to ~/.beevibe/workspaces when not provided", () => {
    const m = new LocalWorkspaceManager({
      mcpServerUrl: MCP_URL,
      runtimeRegistry: fakeRuntimeRegistry,
      skillsSourceDir,
    });
    const root = (m as unknown as { root: string }).root;
    expect(root).toMatch(/\/\.beevibe\/workspaces$/);
  });

  // Regression: previously the constructor used `??` which only checks for
  // null/undefined — an empty-string workspaceRoot (leaked from a stray
  // `WORKSPACE_ROOT=` in .env via Bun's auto-load) slipped through, and
  // downstream `join("", agent.id)` produced a relative path that spawn
  // resolved off the daemon's cwd. The fix uses `||` so any falsy value
  // (empty string included) falls through to the homedir default.
  it("falsy workspaceRoot (empty string) falls back to the homedir default", () => {
    const m = new LocalWorkspaceManager({
      workspaceRoot: "",
      mcpServerUrl: MCP_URL,
      runtimeRegistry: fakeRuntimeRegistry,
      skillsSourceDir,
    });
    const root = (m as unknown as { root: string }).root;
    expect(root).toMatch(/\/\.beevibe\/workspaces$/);
  });

  it("throws on a relative workspaceRoot (fail-fast belt-and-suspenders)", () => {
    expect(
      () =>
        new LocalWorkspaceManager({
          workspaceRoot: "relative/path",
          mcpServerUrl: MCP_URL,
          runtimeRegistry: fakeRuntimeRegistry,
          skillsSourceDir,
        }),
    ).toThrow(/must be absolute/);
  });

  it("removeWorkspace deletes the dir and all contents", async () => {
    const ws = await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_rm" }) });
    writeFileSync(join(ws.path, "file.txt"), "x");
    await manager.removeWorkspace(ws);
    expect(existsSync(ws.path)).toBe(false);
  });

  it("removeWorkspace on a non-existent path is a no-op (no throw)", async () => {
    await expect(
      manager.removeWorkspace({ path: join(workspaceRoot, "does-not-exist") }),
    ).resolves.toBeUndefined();
  });

  it("calls runtime.prepareWorkspace before syncing skills", async () => {
    const calls: string[] = [];
    const runtime = {
      type: "opencode",
      prepareWorkspace: ({ workspace }: { workspace: Workspace }) => {
        calls.push(`prepare:${workspace.path}`);
        writeFileSync(join(workspace.path, "opencode.json"), "{}\n");
      },
      skillsDir: (workspace: Workspace) => {
        calls.push(`skills:${workspace.path}`);
        return join(workspace.path, ".opencode", "skills");
      },
    } as unknown as AgentRuntime;
    const m = new LocalWorkspaceManager({
      workspaceRoot,
      mcpServerUrl: MCP_URL,
      runtimeRegistry: { opencode: runtime },
      skillsSourceDir,
    });

    const ws = await m.ensureWorkspace({
      agent: makeAgent({
        id: "agent_opencode",
        runtime_config: { type: "opencode", model: "openrouter/qwen/qwen3-coder" },
      }),
    });

    expect(existsSync(join(ws.path, "opencode.json"))).toBe(true);
    expect(calls).toEqual([`prepare:${ws.path}`, `skills:${ws.path}`]);
  });

  it("different agents get isolated dirs", async () => {
    const a = await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_a" }) });
    const b = await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_b" }) });
    expect(a.path).not.toBe(b.path);

    writeFileSync(join(a.path, "a-only.txt"), "a");
    expect(existsSync(join(a.path, "a-only.txt"))).toBe(true);
    expect(existsSync(join(b.path, "a-only.txt"))).toBe(false);
  });

  describe("mcp-config.json writeback", () => {
    it("first ensureWorkspace writes mcp-config.json with Bearer token + session-id placeholder", async () => {
      const ws = await manager.ensureWorkspace({
        agent: makeAgent({ id: "agent_cfg", api_key: "bv_a_XyZ" }),
      });
      const configPath = join(ws.path, "mcp-config.json");
      expect(existsSync(configPath)).toBe(true);

      const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(parsed.mcpServers.beevibe.type).toBe("http");
      expect(parsed.mcpServers.beevibe.url).toBe(MCP_URL);
      expect(parsed.mcpServers.beevibe.headers.Authorization).toBe("Bearer bv_a_XyZ");
      expect(parsed.mcpServers.beevibe.headers["X-Beevibe-Session"]).toBe(
        "${BEEVIBE_SESSION_ID}",
      );
    });

    it.skipIf(process.platform === "win32")(
      "mcp-config.json is written with mode 0o600 (file contains secrets)",
      async () => {
        const ws = await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_mode" }) });
        const mode = statSync(join(ws.path, "mcp-config.json")).mode & 0o777;
        expect(mode).toBe(0o600);
      },
    );

    it("second ensureWorkspace does NOT rewrite the config file (file-exists check)", async () => {
      const ws = await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_noredo" }) });
      const configPath = join(ws.path, "mcp-config.json");
      const firstMtime = statSync(configPath).mtimeMs;

      // Tiny wait to ensure mtime resolution would catch a rewrite
      await new Promise((r) => setTimeout(r, 10));
      await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_noredo" }) });

      const secondMtime = statSync(configPath).mtimeMs;
      expect(secondMtime).toBe(firstMtime);
    });

    it("ensureWorkspace re-creates the config after it's deleted (self-heals)", async () => {
      const ws = await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_heal" }) });
      const configPath = join(ws.path, "mcp-config.json");
      unlinkSync(configPath);
      expect(existsSync(configPath)).toBe(false);

      await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_heal" }) });
      expect(existsSync(configPath)).toBe(true);
    });

    it("new instance with different mcpServerUrl auto-refreshes the stale file", async () => {
      await manager.ensureWorkspace({ agent: makeAgent({ id: "agent_stale" }) });
      const configPath = join(workspaceRoot, "agent_stale", "mcp-config.json");
      const original = readFileSync(configPath, "utf-8");

      const different = new LocalWorkspaceManager({
        workspaceRoot,
        mcpServerUrl: "http://different.example/",
        runtimeRegistry: fakeRuntimeRegistry,
        skillsSourceDir,
      });
      await different.ensureWorkspace({ agent: makeAgent({ id: "agent_stale" }) });

      // File now rewrites on URL drift — operator no longer has to `rm`
      // to switch a workspace from localhost to a hosted api after deploy.
      const after = readFileSync(configPath, "utf-8");
      expect(after).not.toBe(original);
      expect(after).not.toContain(MCP_URL);
      expect(after).toContain("different.example");
    });

    it("auto-refreshes when agent.api_key rotates", async () => {
      await manager.ensureWorkspace({
        agent: makeAgent({ id: "agent_rotate", api_key: "bv_a_oldkey" }),
      });
      const configPath = join(workspaceRoot, "agent_rotate", "mcp-config.json");
      expect(readFileSync(configPath, "utf-8")).toContain("Bearer bv_a_oldkey");

      await manager.ensureWorkspace({
        agent: makeAgent({ id: "agent_rotate", api_key: "bv_a_newkey" }),
      });
      const after = readFileSync(configPath, "utf-8");
      expect(after).toContain("Bearer bv_a_newkey");
      expect(after).not.toContain("bv_a_oldkey");
    });

    it("throws when agent has no api_key", async () => {
      await expect(
        manager.ensureWorkspace({
          agent: makeAgent({ id: "agent_nokey", api_key: undefined }),
        }),
      ).rejects.toThrow(/api_key is missing/);
    });
  });

  describe("skill sync (M9.3)", () => {
    function writeSourceSkill(name: string, content = `# ${name}\n`): void {
      const dir = join(skillsSourceDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), content);
    }

    it("IC agent gets only universal skills synced into .claude/skills/", async () => {
      writeSourceSkill("beevibe-pre-task-setup");
      writeSourceSkill("beevibe-team-mesh-negotiation");

      const ws = await manager.ensureWorkspace({
        agent: makeAgent({ id: "agent_ic1", hierarchy_level: "ic" }),
      });

      const skillsDir = join(ws.path, ".claude", "skills");
      const dirs = readdirSync(skillsDir).sort();
      expect(dirs).toContain("beevibe-pre-task-setup");
      expect(dirs).not.toContain("beevibe-team-mesh-negotiation");
    });

    it("team agent gets universal + team-only skills", async () => {
      writeSourceSkill("beevibe-pre-task-setup");
      writeSourceSkill("beevibe-team-mesh-negotiation");

      const ws = await manager.ensureWorkspace({
        agent: makeAgent({ id: "agent_team1", hierarchy_level: "team" }),
      });

      const skillsDir = join(ws.path, ".claude", "skills");
      const dirs = readdirSync(skillsDir).sort();
      expect(dirs).toContain("beevibe-pre-task-setup");
      expect(dirs).toContain("beevibe-team-mesh-negotiation");
    });

    it("re-sync after source SKILL.md edit propagates to existing workspace", async () => {
      writeSourceSkill("beevibe-pre-task-setup", "# v1\n");

      const ws = await manager.ensureWorkspace({
        agent: makeAgent({ id: "agent_resync", hierarchy_level: "ic" }),
      });
      const targetSkillFile = join(ws.path, ".claude", "skills", "beevibe-pre-task-setup", "SKILL.md");
      expect(readFileSync(targetSkillFile, "utf-8")).toContain("# v1");

      // Bump source content + mtime.
      await new Promise((r) => setTimeout(r, 20));
      writeFileSync(join(skillsSourceDir, "beevibe-pre-task-setup", "SKILL.md"), "# v2 with more bytes\n");

      await manager.ensureWorkspace({
        agent: makeAgent({ id: "agent_resync", hierarchy_level: "ic" }),
      });
      expect(readFileSync(targetSkillFile, "utf-8")).toContain("# v2");
    });

    it("throws when agent's runtime_config.type isn't in the registry", async () => {
      await expect(
        manager.ensureWorkspace({
          agent: makeAgent({
            id: "agent_unknown_runtime",
            runtime_config: { type: "totally-fictional-runtime" as "claude" },
          }),
        }),
      ).rejects.toThrow(/No runtime registered/);
    });

    it("does NOT touch user's other personal skills (different prefix)", async () => {
      writeSourceSkill("beevibe-pre-task-setup");

      // Pre-create a non-beevibe skill in the workspace's skills dir.
      // Simulates the user-global ~/.claude/skills case where personal
      // skills coexist with beevibe ones.
      const ws = await manager.ensureWorkspace({
        agent: makeAgent({ id: "agent_iso", hierarchy_level: "ic" }),
      });
      const skillsDir = join(ws.path, ".claude", "skills");
      mkdirSync(join(skillsDir, "frontend-design"), { recursive: true });
      writeFileSync(join(skillsDir, "frontend-design", "SKILL.md"), "user own skill");

      // Re-sync — should leave frontend-design alone.
      await manager.ensureWorkspace({
        agent: makeAgent({ id: "agent_iso", hierarchy_level: "ic" }),
      });

      expect(readFileSync(join(skillsDir, "frontend-design", "SKILL.md"), "utf-8")).toBe(
        "user own skill",
      );
    });
  });
});
