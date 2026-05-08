/**
 * Skills cache. On startup (and on demand), the daemon fetches the
 * canonical skills bundle from /runtime/skills and materializes it
 * into `~/.beevibe/skills/<name>/<file>`. The bundle's `version`
 * (SHA-256 over all file contents) is persisted so subsequent fetches
 * short-circuit on a match.
 *
 * The cache is the daemon's `skillsSourceDir` for `LocalWorkspaceManager`
 * — per-agent tier filtering happens at workspace-sync time, so this
 * cache holds the full skills set.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "./api-client.js";

interface RuntimeSkillFile {
  path: string;
  content: string;
}
interface RuntimeSkill {
  name: string;
  files: RuntimeSkillFile[];
}
interface RuntimeSkillsResponse {
  version: string;
  skills: RuntimeSkill[];
}

export function skillsCacheDir(): string {
  return join(homedir(), ".beevibe", "skills");
}

const VERSION_FILE = ".version";

export async function readCachedVersion(): Promise<string | undefined> {
  try {
    return (await fs.readFile(join(skillsCacheDir(), VERSION_FILE), "utf8"))
      .trim();
  } catch {
    return undefined;
  }
}

/**
 * Fetch /runtime/skills, write the bundle to `~/.beevibe/skills/`.
 * No-op when the server's version matches the local cache. Returns the
 * resolved cache path (always equal to `skillsCacheDir()`).
 */
export async function syncSkillsCache(api: ApiClient): Promise<string> {
  const cache = skillsCacheDir();

  const cached = await readCachedVersion();
  const res = await api.get<RuntimeSkillsResponse>("/runtime/skills");
  if (!res) {
    if (cached) return cache; // server flaky; keep what we have
    throw new Error("/runtime/skills returned no body and no local cache");
  }

  if (cached === res.version) return cache;

  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  // Wipe stale skills before re-materializing. Anything outside the
  // beevibe-namespace stays — the cache dir is dedicated, but be
  // defensive in case a user pointed something else here.
  for (const dirent of await fs.readdir(cache, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    if (
      dirent.name === "beevibe" ||
      dirent.name.startsWith("beevibe-")
    ) {
      await fs.rm(join(cache, dirent.name), { recursive: true, force: true });
    }
  }

  for (const skill of res.skills) {
    const skillDir = join(cache, skill.name);
    await fs.mkdir(skillDir, { recursive: true, mode: 0o700 });
    for (const file of skill.files) {
      const filePath = join(skillDir, file.path);
      await fs.mkdir(join(filePath, ".."), { recursive: true });
      await fs.writeFile(filePath, file.content, { mode: 0o600 });
    }
  }
  await fs.writeFile(join(cache, VERSION_FILE), res.version, { mode: 0o600 });
  return cache;
}
