import { mkdirSync, mkdtempSync, promises as fs, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api-client.js";
import { readCachedVersion, skillsCacheDir, syncSkillsCache } from "./skills-cache.js";

interface SkillsBundle {
  version: string;
  skills: Array<{ name: string; files: Array<{ path: string; content: string }> }>;
}

function bundle(version: string, ...names: string[]): SkillsBundle {
  return {
    version,
    skills: names.map((name) => ({
      name,
      files: [{ path: "SKILL.md", content: `# ${name} @ ${version}` }],
    })),
  };
}

/** ApiClient stand-in that serves one queued `/runtime/skills` body per call. */
function fakeApi(...bodies: Array<SkillsBundle | undefined>) {
  const get = vi.fn(async (path: string) => {
    expect(path).toBe("/runtime/skills");
    return bodies.shift();
  });
  return { api: { get } as unknown as ApiClient, get };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "beevibe-skills-cache-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("skillsCacheDir", () => {
  it("is <configRoot>/skills", () => {
    expect(skillsCacheDir("/tmp/x/.beevibe")).toBe("/tmp/x/.beevibe/skills");
  });
});

describe("readCachedVersion", () => {
  it("returns undefined when the cache has never been written", async () => {
    await expect(readCachedVersion(root)).resolves.toBeUndefined();
  });

  it("returns the version written by a prior sync, trimmed", async () => {
    const cache = skillsCacheDir(root);
    mkdirSync(cache, { recursive: true });
    await fs.writeFile(join(cache, ".version"), "sha-abc\n");

    await expect(readCachedVersion(root)).resolves.toBe("sha-abc");
  });
});

describe("syncSkillsCache", () => {
  it("materializes the bundle and records its version", async () => {
    const { api } = fakeApi(bundle("v1", "beevibe-core", "beevibe-mesh"));

    const cache = await syncSkillsCache(api, root);

    expect(cache).toBe(skillsCacheDir(root));
    await expect(
      fs.readFile(join(cache, "beevibe-core", "SKILL.md"), "utf8"),
    ).resolves.toBe("# beevibe-core @ v1");
    await expect(
      fs.readFile(join(cache, "beevibe-mesh", "SKILL.md"), "utf8"),
    ).resolves.toBe("# beevibe-mesh @ v1");
    await expect(readCachedVersion(root)).resolves.toBe("v1");
  });

  it("creates parent directories for nested file paths", async () => {
    const { api } = fakeApi({
      version: "v1",
      skills: [
        {
          name: "beevibe-core",
          files: [
            { path: "SKILL.md", content: "top" },
            { path: "references/palette.md", content: "nested" },
          ],
        },
      ],
    });

    const cache = await syncSkillsCache(api, root);

    await expect(
      fs.readFile(join(cache, "beevibe-core", "references", "palette.md"), "utf8"),
    ).resolves.toBe("nested");
  });

  it("short-circuits when the server version matches the cache", async () => {
    const { api, get } = fakeApi(bundle("v1", "beevibe-core"), bundle("v1", "beevibe-core"));
    const cache = await syncSkillsCache(api, root);

    // Local edit stands in for "the files were not rewritten".
    await fs.writeFile(join(cache, "beevibe-core", "SKILL.md"), "untouched");
    await syncSkillsCache(api, root);

    expect(get).toHaveBeenCalledTimes(2);
    await expect(
      fs.readFile(join(cache, "beevibe-core", "SKILL.md"), "utf8"),
    ).resolves.toBe("untouched");
  });

  it("re-materializes when the server version moves on", async () => {
    const { api } = fakeApi(bundle("v1", "beevibe-core"), bundle("v2", "beevibe-core"));
    const cache = await syncSkillsCache(api, root);

    await syncSkillsCache(api, root);

    await expect(
      fs.readFile(join(cache, "beevibe-core", "SKILL.md"), "utf8"),
    ).resolves.toBe("# beevibe-core @ v2");
    await expect(readCachedVersion(root)).resolves.toBe("v2");
  });

  it("wipes stale beevibe skills on a version bump but leaves foreign dirs alone", async () => {
    const { api } = fakeApi(
      bundle("v1", "beevibe-core", "beevibe-retired"),
      bundle("v2", "beevibe-core"),
    );
    const cache = await syncSkillsCache(api, root);
    // A directory the daemon did not put there — defensive case in the
    // source: only the beevibe namespace is ever removed.
    await fs.mkdir(join(cache, "someone-elses-skill"), { recursive: true });
    await fs.writeFile(join(cache, "someone-elses-skill", "SKILL.md"), "mine");

    await syncSkillsCache(api, root);

    await expect(fs.readdir(join(cache, "beevibe-retired"))).rejects.toThrow(/ENOENT/);
    await expect(
      fs.readFile(join(cache, "someone-elses-skill", "SKILL.md"), "utf8"),
    ).resolves.toBe("mine");
    await expect(
      fs.readFile(join(cache, "beevibe-core", "SKILL.md"), "utf8"),
    ).resolves.toBe("# beevibe-core @ v2");
  });

  it("keeps the existing cache when the server returns no body", async () => {
    const { api } = fakeApi(bundle("v1", "beevibe-core"), undefined);
    const cache = await syncSkillsCache(api, root);

    await expect(syncSkillsCache(api, root)).resolves.toBe(cache);

    await expect(
      fs.readFile(join(cache, "beevibe-core", "SKILL.md"), "utf8"),
    ).resolves.toBe("# beevibe-core @ v1");
    await expect(readCachedVersion(root)).resolves.toBe("v1");
  });

  it("throws when the server returns no body and there is nothing cached", async () => {
    const { api } = fakeApi(undefined);

    await expect(syncSkillsCache(api, root)).rejects.toThrow(
      /no body and no local cache/,
    );
  });

  it("writes the cache dir 0700 and skill files 0600 — it holds no secrets but is agent-owned", async () => {
    const { api } = fakeApi(bundle("v1", "beevibe-core"));

    const cache = await syncSkillsCache(api, root);

    expect((statSync(cache).mode & 0o777).toString(8)).toBe("700");
    expect(
      (statSync(join(cache, "beevibe-core", "SKILL.md")).mode & 0o777).toString(8),
    ).toBe("600");
    expect((statSync(join(cache, ".version")).mode & 0o777).toString(8)).toBe("600");
  });
});
