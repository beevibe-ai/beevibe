/**
 * Install beevibe skills into the user's Claude Code skill discovery dir
 * (`~/.claude/skills/`). Opt-in for humans who want to act AS a beevibe
 * agent via the M7 manual-smoke flow (their local `claude` CLI connects to
 * api.beevibe.io via mcp-config and authenticates with a bv_u_ token).
 *
 * Same syncSkills primitive the workspace manager uses (M9.3). Only touches
 * dirs in the user's `~/.claude/skills/` that are exactly `beevibe` or
 * start with `beevibe-` — your other personal skills are invisible to this
 * sync and will never be modified or deleted.
 *
 * Usage:
 *   pnpm install-skills           # install / update from <repo>/skills/
 *   pnpm install-skills --dry-run # validate but don't sync
 *
 * Re-run safe: idempotent. After `git pull`, re-run to refresh.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  syncSkills,
  UNIVERSAL_SKILLS,
  TEAM_ONLY_SKILLS,
  type SyncResult,
} from "../packages/core/src/services/skills/index.js";

export const NAMESPACE_PREFIX = "beevibe";
export const ALL_SKILLS = [...UNIVERSAL_SKILLS, ...TEAM_ONLY_SKILLS];

export interface FrontmatterValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Parse YAML frontmatter from SKILL.md and check name + description.
 * Minimal regex-based parse — frontmatter is delimited by `---` lines.
 *
 * Spec contract (Anthropic Agent Skills):
 *   - name: required, kebab-case, ≤64 chars
 *   - description: required, ≤1024 chars
 *
 * Caller should also verify `name` matches the directory name.
 */
export async function validateSkill(
  skillName: string,
  skillDir: string,
): Promise<FrontmatterValidation> {
  const errors: string[] = [];
  const skillMdPath = path.join(skillDir, "SKILL.md");

  let content: string;
  try {
    content = await fs.readFile(skillMdPath, "utf-8");
  } catch {
    errors.push(`${skillName}: SKILL.md missing at ${skillMdPath}`);
    return { ok: false, errors };
  }

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    errors.push(`${skillName}: missing YAML frontmatter (--- ... ---)`);
    return { ok: false, errors };
  }

  const fm = fmMatch[1] ?? "";
  const hasName = /^\s*name\s*:\s*(\S.*)$/m.test(fm);
  const hasDescription = /^\s*description\s*:\s*[\S>]/m.test(fm);
  const nameMatch = fm.match(/^\s*name\s*:\s*([\w-]+)/m);

  if (!hasName) errors.push(`${skillName}: frontmatter missing 'name:' field`);
  if (!hasDescription) errors.push(`${skillName}: frontmatter missing 'description:' field`);
  if (nameMatch && nameMatch[1] !== skillName) {
    errors.push(
      `${skillName}: frontmatter name '${nameMatch[1]}' does not match directory name '${skillName}'`,
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate every shipped skill's frontmatter. Skills not yet authored
 * (e.g. M9.7 in flight) are skipped — syncSkills handles missing-source
 * gracefully.
 */
export async function validateAllSkills(sourceDir: string): Promise<string[]> {
  const errors: string[] = [];
  for (const name of ALL_SKILLS) {
    const skillDir = path.join(sourceDir, name);
    try {
      await fs.access(skillDir);
    } catch {
      continue;
    }
    const result = await validateSkill(name, skillDir);
    errors.push(...result.errors);
  }
  return errors;
}

export interface InstallOptions {
  /** Default `<repo>/skills`. */
  sourceDir?: string;
  /** Default `~/.claude/skills`. */
  targetDir?: string;
  /** Default false. Validate but don't write. */
  dryRun?: boolean;
  /** Default `console.log`. Override for tests. */
  log?: (msg: string) => void;
}

export interface InstallReport {
  validated: boolean;
  validationErrors: string[];
  syncResult?: SyncResult;
}

export async function installSkills(opts: InstallOptions = {}): Promise<InstallReport> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourceDir = opts.sourceDir ?? path.resolve(here, "..", "skills");
  const targetDir = opts.targetDir ?? path.join(homedir(), ".claude", "skills");
  const log = opts.log ?? ((m: string) => console.log(m));

  log(`==> Installing beevibe skills`);
  log(`    source: ${sourceDir}`);
  log(`    target: ${targetDir}`);
  log(`    namespace: ${NAMESPACE_PREFIX}-* (your other skills are untouched)`);
  log("");

  const validationErrors = await validateAllSkills(sourceDir);
  if (validationErrors.length > 0) {
    return { validated: false, validationErrors };
  }

  if (opts.dryRun) {
    log("(--dry-run: skipping actual sync; validation passed)");
    return { validated: true, validationErrors: [] };
  }

  const syncResult = await syncSkills({
    sourceDir,
    targetDir,
    filter: new Set(ALL_SKILLS),
    namespacePrefix: NAMESPACE_PREFIX,
  });

  printResult(syncResult, log);

  return { validated: true, validationErrors: [], syncResult };
}

function printResult(result: SyncResult, log: (m: string) => void): void {
  const total =
    result.added.length + result.updated.length + result.removed.length + result.unchanged.length;
  if (total === 0) {
    log("(no skills found in source)");
    return;
  }

  if (
    result.added.length === 0 &&
    result.updated.length === 0 &&
    result.removed.length === 0
  ) {
    log(`✓ Skills up to date — nothing to sync (${result.unchanged.length} skills).`);
    return;
  }

  if (result.added.length > 0) log(`  added:     ${result.added.join(", ")}`);
  if (result.updated.length > 0) log(`  updated:   ${result.updated.join(", ")}`);
  if (result.removed.length > 0) log(`  removed:   ${result.removed.join(", ")}`);
  if (result.unchanged.length > 0) log(`  unchanged: ${result.unchanged.length} skills`);
}

// Only run main when invoked directly (not when imported by tests).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  installSkills({ dryRun })
    .then((report) => {
      if (!report.validated) {
        console.error("✗ Skill validation failed:");
        for (const e of report.validationErrors) console.error(`  - ${e}`);
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error("✗", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
