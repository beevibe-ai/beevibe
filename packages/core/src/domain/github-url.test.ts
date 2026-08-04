import { describe, expect, it } from "vitest";

import { extractGitHubRepoRefs, NON_REPO_OWNERS } from "./github-url.js";

describe("extractGitHubRepoRefs", () => {
  it("pulls owner, name and canonical root out of a bare URL", () => {
    expect(extractGitHubRepoRefs("see https://github.com/beevibe-ai/beevibe now")).toEqual([
      {
        owner: "beevibe-ai",
        name: "beevibe",
        url: "https://github.com/beevibe-ai/beevibe",
      },
    ]);
  });

  it("collapses a deep path to the repo root", () => {
    const [ref] = extractGitHubRepoRefs(
      "https://github.com/owner/repo/blob/main/CLAUDE.md",
    );
    expect(ref?.url).toBe("https://github.com/owner/repo");
  });

  it("returns nothing for empty text", () => {
    expect(extractGitHubRepoRefs("")).toEqual([]);
  });

  it("skips github.com paths that aren't owners", () => {
    const text = [...NON_REPO_OWNERS]
      .map((o) => `https://github.com/${o}/something`)
      .join("\n");
    expect(extractGitHubRepoRefs(text)).toEqual([]);
  });

  it("matches the non-repo owner list case-insensitively", () => {
    expect(extractGitHubRepoRefs("https://github.com/ORGS/anthropic")).toEqual([]);
  });

  it("strips a .git clone suffix", () => {
    const [ref] = extractGitHubRepoRefs("git clone https://github.com/owner/repo.git");
    expect(ref).toMatchObject({ name: "repo", url: "https://github.com/owner/repo" });
  });

  // `.` is a legal name character, so the regex takes the full stop with it.
  // Left unstripped this yields `repo.` — a URL that 404s and never matches a
  // repo already stored in the learned-skill registry.
  it("strips a trailing period from a URL that ends a sentence", () => {
    const [ref] = extractGitHubRepoRefs("I used https://github.com/owner/repo.");
    expect(ref).toMatchObject({ name: "repo", url: "https://github.com/owner/repo" });
  });

  it("keeps interior dots in the repo name", () => {
    const [ref] = extractGitHubRepoRefs("https://github.com/owner/my.cool.repo ");
    expect(ref?.name).toBe("my.cool.repo");
  });

  it("stops at closing punctuation around a markdown link", () => {
    const [ref] = extractGitHubRepoRefs("[repo](https://github.com/owner/repo)");
    expect(ref?.url).toBe("https://github.com/owner/repo");
  });

  it("finds every mention in order, without deduping", () => {
    const refs = extractGitHubRepoRefs(
      "https://github.com/a/one and https://github.com/b/two and https://github.com/a/one",
    );
    expect(refs.map((r) => r.url)).toEqual([
      "https://github.com/a/one",
      "https://github.com/b/two",
      "https://github.com/a/one",
    ]);
  });

  // The module-level regex is global; a stale lastIndex would make the second
  // call start mid-string and miss the match.
  it("is not order-dependent across calls", () => {
    const text = "https://github.com/owner/repo";
    expect(extractGitHubRepoRefs(text)).toEqual(extractGitHubRepoRefs(text));
  });
});
