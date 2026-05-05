/**
 * install-skills CLI tests (M9.6). Each test uses tmpdirs for source +
 * target — no touching the user's real ~/.claude/skills/.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkills, validateSkill } from "./install-skills.js";

let workdir: string;
let sourceDir: string;
let targetDir: string;
let logs: string[];

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "install-skills-test-"));
  sourceDir = path.join(workdir, "skills");
  targetDir = path.join(workdir, "target");
  await fs.mkdir(sourceDir);
  await fs.mkdir(targetDir);
  logs = [];
});

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

async function writeSkill(
  name: string,
  body = "# body\n",
  frontmatter = `name: ${name}\ndescription: >\n  A test skill body.`,
): Promise<void> {
  const dir = path.join(sourceDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
}

describe("validateSkill", () => {
  it("passes when frontmatter has name + description and name matches dir", async () => {
    await writeSkill("beevibe-pre-task-setup");
    const result = await validateSkill(
      "beevibe-pre-task-setup",
      path.join(sourceDir, "beevibe-pre-task-setup"),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when SKILL.md is missing", async () => {
    const dir = path.join(sourceDir, "beevibe-empty");
    await fs.mkdir(dir);
    const result = await validateSkill("beevibe-empty", dir);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/SKILL.md missing/);
  });

  it("fails when frontmatter is missing", async () => {
    const dir = path.join(sourceDir, "beevibe-naked");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "SKILL.md"), "# just a body, no frontmatter\n");
    const result = await validateSkill("beevibe-naked", dir);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/missing YAML frontmatter/);
  });

  it("fails when 'name' field is missing from frontmatter", async () => {
    await writeSkill("beevibe-noname", "# body\n", `description: >\n  Has no name.`);
    const result = await validateSkill("beevibe-noname", path.join(sourceDir, "beevibe-noname"));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/missing 'name:'/);
  });

  it("fails when 'description' field is missing from frontmatter", async () => {
    await writeSkill("beevibe-nodesc", "# body\n", `name: beevibe-nodesc`);
    const result = await validateSkill("beevibe-nodesc", path.join(sourceDir, "beevibe-nodesc"));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/missing 'description:'/);
  });

  it("fails when frontmatter name does not match directory name", async () => {
    await writeSkill(
      "beevibe-mismatched",
      "# body\n",
      `name: beevibe-something-else\ndescription: >\n  Mismatched name.`,
    );
    const result = await validateSkill(
      "beevibe-mismatched",
      path.join(sourceDir, "beevibe-mismatched"),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/does not match directory name/);
  });
});

describe("installSkills", () => {
  it("installs valid skills into the target dir", async () => {
    await writeSkill("beevibe-team-mesh-negotiation");
    await writeSkill("beevibe-pre-task-setup");

    const report = await installSkills({
      sourceDir,
      targetDir,
      log: (m) => logs.push(m),
    });

    expect(report.validated).toBe(true);
    expect(report.validationErrors).toEqual([]);
    expect(report.syncResult?.added.sort()).toEqual(["beevibe-pre-task-setup", "beevibe-team-mesh-negotiation"]);

    const dirs = await fs.readdir(targetDir);
    expect(dirs.sort()).toEqual(["beevibe-pre-task-setup", "beevibe-team-mesh-negotiation"]);
  });

  it("idempotent re-run — no changes when source unchanged", async () => {
    await writeSkill("beevibe-team-mesh-negotiation");

    await installSkills({ sourceDir, targetDir, log: (m) => logs.push(m) });
    logs = [];
    const report = await installSkills({
      sourceDir,
      targetDir,
      log: (m) => logs.push(m),
    });

    expect(report.syncResult?.added).toEqual([]);
    expect(report.syncResult?.updated).toEqual([]);
    expect(report.syncResult?.removed).toEqual([]);
    expect(logs.some((l) => /up to date/.test(l))).toBe(true);
  });

  it("does NOT touch the user's other personal skills (different prefix)", async () => {
    await writeSkill("beevibe-team-mesh-negotiation");

    // Pre-create a non-beevibe skill in target — simulating the user's own.
    await fs.mkdir(path.join(targetDir, "frontend-design"), { recursive: true });
    await fs.writeFile(path.join(targetDir, "frontend-design", "SKILL.md"), "user own skill");

    await installSkills({ sourceDir, targetDir, log: (m) => logs.push(m) });

    expect(await fs.readFile(path.join(targetDir, "frontend-design", "SKILL.md"), "utf-8")).toBe(
      "user own skill",
    );
  });

  it("aborts on validation failure (no sync happens)", async () => {
    await writeSkill("beevibe-team-mesh-negotiation");
    // Make a malformed beevibe-pre-task-setup (one of ALL_SKILLS).
    const badDir = path.join(sourceDir, "beevibe-pre-task-setup");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, "SKILL.md"), "no frontmatter at all");

    const report = await installSkills({
      sourceDir,
      targetDir,
      log: (m) => logs.push(m),
    });

    expect(report.validated).toBe(false);
    expect(report.validationErrors.length).toBeGreaterThan(0);
    expect(report.syncResult).toBeUndefined();

    // No skills synced because validation failed before sync.
    const dirs = await fs.readdir(targetDir);
    expect(dirs).toEqual([]);
  });

  it("dry-run validates but does not write", async () => {
    await writeSkill("beevibe-team-mesh-negotiation");

    const report = await installSkills({
      sourceDir,
      targetDir,
      dryRun: true,
      log: (m) => logs.push(m),
    });

    expect(report.validated).toBe(true);
    expect(report.syncResult).toBeUndefined();

    const dirs = await fs.readdir(targetDir);
    expect(dirs).toEqual([]);
  });
});
