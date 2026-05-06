/**
 * syncSkills tests (M9.2). Each test uses a fresh tmpdir for source +
 * target. Covers add, update, remove, no-op, namespace safety, and
 * idempotent re-runs.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncSkills, type SyncResult } from "./sync.js";

let workdir: string;

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-skills-test-"));
});

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

async function writeSkill(
  root: string,
  name: string,
  files: Record<string, string> = { "SKILL.md": `# ${name}\n` },
): Promise<void> {
  const dir = path.join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
}

async function readFileIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

describe("syncSkills", () => {
  it("adds skills when target is empty", async () => {
    const sourceDir = path.join(workdir, "src");
    const targetDir = path.join(workdir, "tgt");
    await writeSkill(sourceDir, "beevibe");
    await writeSkill(sourceDir, "beevibe-task-completion");

    const result = await syncSkills({
      sourceDir,
      targetDir,
      filter: new Set(["beevibe", "beevibe-task-completion"]),
      namespacePrefix: "beevibe",
    });

    expect(result.added.sort()).toEqual(["beevibe", "beevibe-task-completion"]);
    expect(result.updated).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(await readFileIfExists(path.join(targetDir, "beevibe", "SKILL.md"))).toContain(
      "# beevibe",
    );
  });

  it("skips unchanged skills (mtime + size match)", async () => {
    const sourceDir = path.join(workdir, "src");
    const targetDir = path.join(workdir, "tgt");
    await writeSkill(sourceDir, "beevibe");

    // First sync: add.
    const filter = new Set(["beevibe"]);
    await syncSkills({ sourceDir, targetDir, filter, namespacePrefix: "beevibe" });

    // Second sync: no source changes → all unchanged.
    const result = await syncSkills({
      sourceDir,
      targetDir,
      filter,
      namespacePrefix: "beevibe",
    });
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged).toEqual(["beevibe"]);
  });

  it("updates skill when source has newer mtime", async () => {
    const sourceDir = path.join(workdir, "src");
    const targetDir = path.join(workdir, "tgt");
    await writeSkill(sourceDir, "beevibe", { "SKILL.md": "# v1\n" });
    const filter = new Set(["beevibe"]);
    await syncSkills({ sourceDir, targetDir, filter, namespacePrefix: "beevibe" });

    // Bump source content + mtime.
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(path.join(sourceDir, "beevibe", "SKILL.md"), "# v2 with more content\n");

    const result = await syncSkills({
      sourceDir,
      targetDir,
      filter,
      namespacePrefix: "beevibe",
    });
    expect(result.updated).toEqual(["beevibe"]);
    expect(await readFileIfExists(path.join(targetDir, "beevibe", "SKILL.md"))).toContain("# v2");
  });

  it("updates skill when file added inside skill dir", async () => {
    const sourceDir = path.join(workdir, "src");
    const targetDir = path.join(workdir, "tgt");
    await writeSkill(sourceDir, "beevibe", { "SKILL.md": "# umbrella\n" });
    const filter = new Set(["beevibe"]);
    await syncSkills({ sourceDir, targetDir, filter, namespacePrefix: "beevibe" });

    // Add a reference file.
    await fs.mkdir(path.join(sourceDir, "beevibe", "references"), { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "beevibe", "references", "extra.md"),
      "extra content",
    );

    const result = await syncSkills({
      sourceDir,
      targetDir,
      filter,
      namespacePrefix: "beevibe",
    });
    expect(result.updated).toEqual(["beevibe"]);
    expect(
      await readFileIfExists(path.join(targetDir, "beevibe", "references", "extra.md")),
    ).toBe("extra content");
  });

  it("updates skill when file removed inside skill dir", async () => {
    const sourceDir = path.join(workdir, "src");
    const targetDir = path.join(workdir, "tgt");
    await writeSkill(sourceDir, "beevibe", {
      "SKILL.md": "# umbrella\n",
      "references/old.md": "doomed",
    });
    const filter = new Set(["beevibe"]);
    await syncSkills({ sourceDir, targetDir, filter, namespacePrefix: "beevibe" });
    expect(await readFileIfExists(path.join(targetDir, "beevibe", "references", "old.md"))).toBe(
      "doomed",
    );

    // Remove from source.
    await fs.rm(path.join(sourceDir, "beevibe", "references", "old.md"));

    const result = await syncSkills({
      sourceDir,
      targetDir,
      filter,
      namespacePrefix: "beevibe",
    });
    expect(result.updated).toEqual(["beevibe"]);
    expect(await readFileIfExists(path.join(targetDir, "beevibe", "references", "old.md"))).toBe(
      null,
    );
  });

  it("removes skill when no longer in filter", async () => {
    const sourceDir = path.join(workdir, "src");
    const targetDir = path.join(workdir, "tgt");
    await writeSkill(sourceDir, "beevibe");
    await writeSkill(sourceDir, "beevibe-team-mesh-negotiation");

    // Initial sync includes both.
    await syncSkills({
      sourceDir,
      targetDir,
      filter: new Set(["beevibe", "beevibe-team-mesh-negotiation"]),
      namespacePrefix: "beevibe",
    });

    // Filter shrinks (e.g., agent demoted from team to ic).
    const result = await syncSkills({
      sourceDir,
      targetDir,
      filter: new Set(["beevibe"]),
      namespacePrefix: "beevibe",
    });
    expect(result.removed).toEqual(["beevibe-team-mesh-negotiation"]);
    expect(await readFileIfExists(path.join(targetDir, "beevibe-team-mesh-negotiation", "SKILL.md"))).toBe(
      null,
    );
  });

  it("removes skill when source dir deleted but filter still references it", async () => {
    const sourceDir = path.join(workdir, "src");
    const targetDir = path.join(workdir, "tgt");
    await writeSkill(sourceDir, "beevibe-deprecated");

    const filter = new Set(["beevibe-deprecated"]);
    await syncSkills({ sourceDir, targetDir, filter, namespacePrefix: "beevibe" });
    expect(await readFileIfExists(path.join(targetDir, "beevibe-deprecated", "SKILL.md"))).not.toBe(
      null,
    );

    // Source skill removed.
    await fs.rm(path.join(sourceDir, "beevibe-deprecated"), { recursive: true });

    const result = await syncSkills({
      sourceDir,
      targetDir,
      filter,
      namespacePrefix: "beevibe",
    });
    expect(result.removed).toEqual(["beevibe-deprecated"]);
  });

  it("IGNORES non-prefix-matching dirs in target (user's other skills)", async () => {
    const sourceDir = path.join(workdir, "src");
    const targetDir = path.join(workdir, "tgt");
    await writeSkill(sourceDir, "beevibe");

    // Pre-populate target with the user's personal skill.
    await fs.mkdir(path.join(targetDir, "frontend-design"), { recursive: true });
    await fs.writeFile(path.join(targetDir, "frontend-design", "SKILL.md"), "user's own skill");

    const result = await syncSkills({
      sourceDir,
      targetDir,
      filter: new Set(["beevibe"]),
      namespacePrefix: "beevibe",
    });

    expect(result.added).toEqual(["beevibe"]);
    expect(result.removed).toEqual([]);
    expect(await readFileIfExists(path.join(targetDir, "frontend-design", "SKILL.md"))).toBe(
      "user's own skill",
    );
  });

  it("handles idempotent re-run after partial completion", async () => {
    // Simulate an interrupted sync: skill exists but is incomplete.
    const sourceDir = path.join(workdir, "src");
    const targetDir = path.join(workdir, "tgt");
    await writeSkill(sourceDir, "beevibe", {
      "SKILL.md": "# v1\n",
      "references/a.md": "A",
      "references/b.md": "B",
    });
    // Pre-create target with only one of two reference files.
    await fs.mkdir(path.join(targetDir, "beevibe", "references"), { recursive: true });
    await fs.writeFile(path.join(targetDir, "beevibe", "SKILL.md"), "# stale\n");
    await fs.writeFile(path.join(targetDir, "beevibe", "references", "a.md"), "A-stale");

    const result = await syncSkills({
      sourceDir,
      targetDir,
      filter: new Set(["beevibe"]),
      namespacePrefix: "beevibe",
    });

    expect(result.updated).toEqual(["beevibe"]);
    expect(await readFileIfExists(path.join(targetDir, "beevibe", "references", "b.md"))).toBe("B");

    // Second run is a no-op.
    const result2 = await syncSkills({
      sourceDir,
      targetDir,
      filter: new Set(["beevibe"]),
      namespacePrefix: "beevibe",
    });
    expect(result2.unchanged).toEqual(["beevibe"]);
  });

  it("handles symlinked source files", async () => {
    const sourceDir = path.join(workdir, "src");
    const targetDir = path.join(workdir, "tgt");

    // Create a real file outside the skill, then symlink it in.
    const externalDir = path.join(workdir, "external");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(path.join(externalDir, "real.md"), "real content");

    await fs.mkdir(path.join(sourceDir, "beevibe"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "beevibe", "SKILL.md"), "# umbrella\n");
    await fs.symlink(path.join(externalDir, "real.md"), path.join(sourceDir, "beevibe", "linked.md"));

    const result: SyncResult = await syncSkills({
      sourceDir,
      targetDir,
      filter: new Set(["beevibe"]),
      namespacePrefix: "beevibe",
    });

    expect(result.added).toEqual(["beevibe"]);
    // Symlink is followed; target has the resolved content.
    expect(await readFileIfExists(path.join(targetDir, "beevibe", "linked.md"))).toBe(
      "real content",
    );
  });
});
