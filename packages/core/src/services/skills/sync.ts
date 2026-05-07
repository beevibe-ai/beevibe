/**
 * syncSkills — copy a tier-filtered subset of skill folders from a source
 * directory into a target directory, with mtime+size-based per-file diff
 * for idempotent re-runs (M9.2).
 *
 * Two callers, single source of truth:
 *   - LocalWorkspaceManager.ensureWorkspace (M9.3) — per-agent workspace
 *     sync into `<workspace>/.claude/skills/`
 *   - scripts/install-skills.ts (M9.6) — opt-in user-global install into
 *     `~/.claude/skills/`
 *
 * Safety: namespacePrefix bounds what we look at in target. Only dirs that
 * are exactly the prefix or start with `${prefix}-` are touched. The user's
 * other skills (different prefix) are invisible to sync.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface SyncResult {
  /** Skill names copied for the first time (target had no entry). */
  added: string[];
  /** Skill names with at least one changed file (mtime/size mismatch). */
  updated: string[];
  /** Skill names removed from target (not in filter, or source deleted). */
  removed: string[];
  /** Skill names whose target already matched source byte-by-byte. */
  unchanged: string[];
}

export interface SyncSkillsOptions {
  /** Path to the canonical skills directory (e.g. `<repo>/skills`). */
  sourceDir: string;
  /** Path to the target directory (e.g. `<workspace>/.claude/skills`). */
  targetDir: string;
  /** Allowed skill names. Anything in target not in this set gets removed. */
  filter: Set<string>;
  /**
   * Safety boundary. Sync only inspects dirs that are exactly this name
   * OR start with `${namespacePrefix}-`. Other dirs (e.g. user's personal
   * skills) are completely invisible to sync.
   */
  namespacePrefix: string;
}

export async function syncSkills(opts: SyncSkillsOptions): Promise<SyncResult> {
  const { sourceDir, targetDir, filter, namespacePrefix } = opts;
  const result: SyncResult = { added: [], updated: [], removed: [], unchanged: [] };

  await fs.mkdir(targetDir, { recursive: true });

  // Step 1: enumerate target's namespace-matching skills.
  const targetEntries = await fs.readdir(targetDir, { withFileTypes: true });
  const targetSkills = new Set<string>();
  for (const entry of targetEntries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === namespacePrefix || name.startsWith(`${namespacePrefix}-`)) {
      targetSkills.add(name);
    }
  }

  // Step 2: remove orphans (in target's namespace but not in filter).
  for (const name of targetSkills) {
    if (!filter.has(name)) {
      await fs.rm(path.join(targetDir, name), { recursive: true, force: true });
      result.removed.push(name);
    }
  }

  // Step 3: add or update each filtered skill.
  for (const name of filter) {
    const src = path.join(sourceDir, name);
    const tgt = path.join(targetDir, name);

    const srcExists = await pathExists(src);
    if (!srcExists) {
      // Source removed but still in filter — caller's filter is stale.
      // Treat as orphan: remove from target if present.
      if (targetSkills.has(name)) {
        await fs.rm(tgt, { recursive: true, force: true });
        result.removed.push(name);
      }
      continue;
    }

    if (!targetSkills.has(name)) {
      await copyDir(src, tgt);
      result.added.push(name);
      continue;
    }

    const changed = await syncDirIfChanged(src, tgt);
    if (changed) result.updated.push(name);
    else result.unchanged.push(name);
  }

  return result;
}

// ── helpers ─────────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      // fs.copyFile follows symlinks; that's what we want — we read the
      // resolved file content into the target. Symlinked source files
      // are common in dev workflows (linking shared snippets).
      await fs.copyFile(s, d);
    }
  }
}

/**
 * Walk src + tgt in parallel. For each src file:
 *   - copy if no tgt counterpart, or if mtime/size differs
 * For each tgt file not in src:
 *   - delete (handles file rename within a skill)
 * Returns true if any file changed; false if everything matched.
 */
async function syncDirIfChanged(src: string, tgt: string): Promise<boolean> {
  let changed = false;

  const srcFiles = await listFilesRecursive(src);
  const tgtFiles = await listFilesRecursive(tgt);
  const srcRel = new Set(srcFiles.map((f) => path.relative(src, f)));

  for (const srcFile of srcFiles) {
    const rel = path.relative(src, srcFile);
    const tgtFile = path.join(tgt, rel);
    const srcStat = await fs.stat(srcFile);
    let tgtStat;
    try {
      tgtStat = await fs.stat(tgtFile);
    } catch {
      tgtStat = null;
    }
    const needsCopy =
      !tgtStat ||
      tgtStat.mtimeMs < srcStat.mtimeMs ||
      tgtStat.size !== srcStat.size;
    if (needsCopy) {
      await fs.mkdir(path.dirname(tgtFile), { recursive: true });
      await fs.copyFile(srcFile, tgtFile);
      changed = true;
    }
  }

  for (const tgtFile of tgtFiles) {
    const rel = path.relative(tgt, tgtFile);
    if (!srcRel.has(rel)) {
      await fs.rm(tgtFile, { force: true });
      changed = true;
    }
  }

  return changed;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() || entry.isSymbolicLink()) out.push(p);
    }
  }
  if (await pathExists(dir)) await walk(dir);
  return out;
}
