import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalWorkspaceManager } from "./manager.js";

describe("LocalWorkspaceManager", () => {
  let workspaceRoot: string;
  let manager: LocalWorkspaceManager;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "beevibe-ws-test-"));
    manager = new LocalWorkspaceManager({ workspaceRoot });
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("ensureWorkspace creates the agent dir under workspaceRoot", async () => {
    const ws = await manager.ensureWorkspace({ agent_id: "agent_abc" });
    expect(ws.path).toBe(join(workspaceRoot, "agent_abc"));
    expect(existsSync(ws.path)).toBe(true);
    expect(statSync(ws.path).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "dir is created with 0o700 (user-only) permissions",
    async () => {
      const ws = await manager.ensureWorkspace({ agent_id: "agent_perms" });
      const mode = statSync(ws.path).mode & 0o777;
      expect(mode).toBe(0o700);
    },
  );

  it("ensureWorkspace is idempotent: second call returns same path, doesn't error", async () => {
    const ws1 = await manager.ensureWorkspace({ agent_id: "agent_idem" });
    const ws2 = await manager.ensureWorkspace({ agent_id: "agent_idem" });
    expect(ws2.path).toBe(ws1.path);
  });

  it("ensureWorkspace preserves existing files inside the dir (persistence)", async () => {
    const ws = await manager.ensureWorkspace({ agent_id: "agent_persist" });
    writeFileSync(join(ws.path, "notes.md"), "# notes\n");
    writeFileSync(join(ws.path, "cloned-repo.txt"), "repo data");

    // Second call should NOT wipe the dir
    await manager.ensureWorkspace({ agent_id: "agent_persist" });

    const files = readdirSync(ws.path).sort();
    expect(files).toEqual(["cloned-repo.txt", "notes.md"]);
  });

  it("recursive mkdir creates missing parent dirs", async () => {
    const deepRoot = join(workspaceRoot, "nested", "deeper");
    const deepManager = new LocalWorkspaceManager({ workspaceRoot: deepRoot });
    const ws = await deepManager.ensureWorkspace({ agent_id: "agent_deep" });
    expect(existsSync(ws.path)).toBe(true);
    expect(ws.path).toBe(join(deepRoot, "agent_deep"));
  });

  it("defaults workspaceRoot to ~/.beevibe/workspaces when not provided", () => {
    const m = new LocalWorkspaceManager();
    // Inspecting private field via cast — acceptable for a sanity test
    const root = (m as unknown as { root: string }).root;
    expect(root).toMatch(/\/\.beevibe\/workspaces$/);
  });

  it("removeWorkspace deletes the dir and all contents", async () => {
    const ws = await manager.ensureWorkspace({ agent_id: "agent_rm" });
    writeFileSync(join(ws.path, "file.txt"), "x");
    await manager.removeWorkspace(ws);
    expect(existsSync(ws.path)).toBe(false);
  });

  it("removeWorkspace on a non-existent path is a no-op (no throw)", async () => {
    await expect(
      manager.removeWorkspace({ path: join(workspaceRoot, "does-not-exist") }),
    ).resolves.toBeUndefined();
  });

  it("different agents get isolated dirs", async () => {
    const a = await manager.ensureWorkspace({ agent_id: "agent_a" });
    const b = await manager.ensureWorkspace({ agent_id: "agent_b" });
    expect(a.path).not.toBe(b.path);

    writeFileSync(join(a.path, "a-only.txt"), "a");
    expect(existsSync(join(a.path, "a-only.txt"))).toBe(true);
    expect(existsSync(join(b.path, "a-only.txt"))).toBe(false);
  });
});
