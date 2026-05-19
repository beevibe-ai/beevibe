/**
 * Tests for the boost-list loader's remote-first → disk-fallback path.
 * The loader runs once at server startup; getting the precedence right
 * here matters because a silent regression would mean every hosted
 * beevibe instance falls back to a possibly-stale bundled disk copy
 * (or worse, an empty list with Tier 3 effectively disabled).
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  inMemoryBoostList,
  loadBoostList,
  loadBoostListFromDisk,
} from "./boost-list.js";

function makeRemoteFetcher(body: unknown, opts: { ok?: boolean } = {}): typeof fetch {
  return vi.fn(async () => ({
    ok: opts.ok ?? true,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function throwingFetcher(): typeof fetch {
  return vi.fn(async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}

function writeBoostFile(repoRoot: string, body: unknown): void {
  const dir = join(repoRoot, "skills", "beevibe-discover-repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "boost-list.json"), JSON.stringify(body), "utf8");
}

const VALID_REMOTE = {
  version: "1.0.0",
  entries: [
    {
      repo_url: "https://github.com/jsvine/pdfplumber",
      goal_keywords: ["pdf", "extract"],
      language: "python",
      category: "data",
    },
    {
      repo_url: "https://github.com/yt-dlp/yt-dlp",
      goal_keywords: ["video", "download"],
      language: "python",
      category: "media",
    },
  ],
};

const VALID_DISK = {
  version: "1.0.0",
  entries: [
    {
      repo_url: "https://github.com/disk-only/repo",
      goal_keywords: ["disk", "only"],
      language: "python",
      category: "test",
    },
  ],
};

describe("inMemoryBoostList", () => {
  it("returns the entries it was constructed with", () => {
    const list = inMemoryBoostList([
      { repo_url: "https://github.com/a/b", goal_keywords: ["x"], language: "go", category: "tool" },
    ]);
    expect(list.entries()).toHaveLength(1);
    expect(list.entries()[0]!.repo_url).toBe("https://github.com/a/b");
  });
});

describe("loadBoostList", () => {
  it("prefers the remote source when fetch succeeds", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "boost-test-"));
    writeBoostFile(tmp, VALID_DISK); // disk would return 1 entry
    const list = await loadBoostList({
      repoRoot: tmp,
      remoteUrl: "https://example.test/boost",
      fetcher: makeRemoteFetcher(VALID_REMOTE),
    });
    // Remote has 2 entries; disk has 1 — remote wins.
    expect(list.entries()).toHaveLength(2);
    expect(list.entries()[0]!.repo_url).toBe("https://github.com/jsvine/pdfplumber");
  });

  it("falls back to disk when remote fetch throws", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "boost-test-"));
    writeBoostFile(tmp, VALID_DISK);
    const list = await loadBoostList({
      repoRoot: tmp,
      remoteUrl: "https://example.test/boost",
      fetcher: throwingFetcher(),
    });
    expect(list.entries()).toHaveLength(1);
    expect(list.entries()[0]!.repo_url).toBe("https://github.com/disk-only/repo");
  });

  it("falls back to disk when remote returns non-ok", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "boost-test-"));
    writeBoostFile(tmp, VALID_DISK);
    const list = await loadBoostList({
      repoRoot: tmp,
      remoteUrl: "https://example.test/boost",
      fetcher: makeRemoteFetcher({}, { ok: false }),
    });
    expect(list.entries()).toHaveLength(1);
    expect(list.entries()[0]!.repo_url).toBe("https://github.com/disk-only/repo");
  });

  it("falls back to disk when remote returns malformed JSON shape", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "boost-test-"));
    writeBoostFile(tmp, VALID_DISK);
    const list = await loadBoostList({
      repoRoot: tmp,
      remoteUrl: "https://example.test/boost",
      fetcher: makeRemoteFetcher({ entries: "not-an-array" }),
    });
    expect(list.entries()).toHaveLength(1);
    expect(list.entries()[0]!.repo_url).toBe("https://github.com/disk-only/repo");
  });

  it("returns empty list when both remote and disk fail", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "boost-test-"));
    // No disk file written
    const list = await loadBoostList({
      repoRoot: tmp,
      remoteUrl: "https://example.test/boost",
      fetcher: throwingFetcher(),
    });
    expect(list.entries()).toHaveLength(0);
  });

  it("skips entries missing repo_url or goal_keywords (defensive parse)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "boost-test-"));
    writeBoostFile(tmp, VALID_DISK); // unused — remote will succeed
    const list = await loadBoostList({
      repoRoot: tmp,
      remoteUrl: "https://example.test/boost",
      fetcher: makeRemoteFetcher({
        entries: [
          { repo_url: "https://github.com/ok/one", goal_keywords: ["x"], language: "go", category: "ok" },
          { goal_keywords: ["missing-url"], language: "go", category: "bad" }, // bad: no repo_url
          { repo_url: "https://github.com/ok/two", goal_keywords: [], language: "go", category: "bad" }, // bad: empty keywords
          { repo_url: "https://github.com/ok/three", goal_keywords: ["y"] }, // ok: defaults for language/category
        ],
      }),
    });
    expect(list.entries()).toHaveLength(2);
    expect(list.entries().map((e) => e.repo_url)).toEqual([
      "https://github.com/ok/one",
      "https://github.com/ok/three",
    ]);
    expect(list.entries()[1]!.language).toBe("unknown");
    expect(list.entries()[1]!.category).toBe("uncategorized");
  });
});

describe("loadBoostListFromDisk", () => {
  it("reads and parses a valid bundled file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "boost-test-"));
    writeBoostFile(tmp, VALID_DISK);
    const list = await loadBoostListFromDisk(tmp);
    expect(list.entries()).toHaveLength(1);
  });

  it("returns empty list when the file is missing (ENOENT)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "boost-test-"));
    const list = await loadBoostListFromDisk(tmp);
    expect(list.entries()).toHaveLength(0);
  });
});
