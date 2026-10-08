import { describe, expect, it } from "vitest";
import {
  cleanRepoDescription,
  defaultTryGoal,
  formatStars,
  repoOwner,
  repoShortName,
  repoSlug,
  slugify,
} from "./capabilities";

/**
 * The two inline implementations these replaced, verbatim from the sibling
 * files they lived in. Both were named `repoName`; they returned different
 * strings. The parity tests below pin each accessor to the copy it replaced,
 * which is what keeps the two rows rendering exactly as they did.
 */
const oldCapabilitiesRepoName = (url: string) => {
  const parts = url.replace("https://github.com/", "").split("/");
  return parts[1] ?? parts[0] ?? url;
};
const oldRunCardRepoName = (url: string) => {
  const parts = url.replace("https://github.com/", "").split("/");
  return parts.slice(0, 2).join("/");
};
const oldOwner = (url: string) => url.replace("https://github.com/", "").split("/")[0] ?? "";

const URLS = [
  "https://github.com/facebook/react",
  "https://github.com/facebook/react/tree/main/packages",
  "https://github.com/facebook",
  "https://gitlab.com/owner/repo",
  "facebook/react",
  "react",
  "",
];

describe("repo URL accessors", () => {
  it("repoShortName returns the repo segment", () => {
    expect(repoShortName("https://github.com/facebook/react")).toBe("react");
  });

  it("repoOwner returns the owner segment", () => {
    expect(repoOwner("https://github.com/facebook/react")).toBe("facebook");
  });

  it("repoSlug returns owner/repo", () => {
    expect(repoSlug("https://github.com/facebook/react")).toBe("facebook/react");
  });

  it("repoShortName and repoSlug genuinely differ — the drift that motivated this", () => {
    const url = "https://github.com/facebook/react";
    expect(repoShortName(url)).toBe("react");
    expect(repoSlug(url)).toBe("facebook/react");
    expect(repoShortName(url)).not.toBe(repoSlug(url));
  });

  it("ignores extra path segments beyond owner/repo", () => {
    const deep = "https://github.com/facebook/react/tree/main/packages";
    expect(repoShortName(deep)).toBe("react");
    expect(repoSlug(deep)).toBe("facebook/react");
    expect(repoOwner(deep)).toBe("facebook");
  });

  it("passes bare and malformed input through, as the inline copies did", () => {
    expect(repoSlug("react")).toBe("react");
    expect(repoShortName("react")).toBe("react");
    expect(repoOwner("react")).toBe("react");
    expect(repoOwner("")).toBe("");
    expect(repoSlug("")).toBe("");
    expect(repoShortName("")).toBe("");
  });

  it("degrades oddly on a non-GitHub host — preserved, not fixed, here", () => {
    // The `replace` only strips the github.com prefix, so a gitlab URL keeps
    // its scheme and splits into ["https:", "", "gitlab.com", "owner", "repo"].
    // Segment 1 is the empty string between the two slashes, which is not
    // nullish, so `parts[1] ?? …` yields "" rather than falling back.
    //
    // Both inline copies behaved this way and no caller passes a non-GitHub
    // URL today (every `repo_url` on the wire is a github.com link), so this
    // records the existing behavior rather than changing it under cover of a
    // refactor. Worth fixing deliberately if these ever take arbitrary hosts.
    const gitlab = "https://gitlab.com/owner/repo";
    expect(repoShortName(gitlab)).toBe("");
    expect(repoOwner(gitlab)).toBe("https:");
    expect(repoSlug(gitlab)).toBe("https:/");
  });

  it.each(URLS)("matches the replaced inline implementations for %o", (url) => {
    expect(repoShortName(url)).toBe(oldCapabilitiesRepoName(url));
    expect(repoSlug(url)).toBe(oldRunCardRepoName(url));
    expect(repoOwner(url)).toBe(oldOwner(url));
  });
});

/** The pre-existing helpers in this module had no coverage at all. */
describe("formatStars", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1.0k"],
    [1234, "1.2k"],
    [9999, "10.0k"],
    [10000, "10k"],
    [18500, "19k"],
  ])("%i → %s", (n, want) => {
    expect(formatStars(n)).toBe(want);
  });
});

describe("slugify", () => {
  it("lowercases, collapses non-alphanumerics, and trims the dashes", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("--Already-Slugged--")).toBe("already-slugged");
  });

  it("caps at 64 characters", () => {
    expect(slugify("a".repeat(100))).toHaveLength(64);
  });
});

describe("cleanRepoDescription", () => {
  it("drops a leading emoji and gemoji shortcode", () => {
    expect(cleanRepoDescription("🤖 Your AI assistant")).toBe("Your AI assistant");
    expect(cleanRepoDescription(":books: A library")).toBe("A library");
  });

  it("returns undefined for empty, nullish, or emoji-only input", () => {
    expect(cleanRepoDescription(null)).toBeUndefined();
    expect(cleanRepoDescription(undefined)).toBeUndefined();
    expect(cleanRepoDescription("   ")).toBeUndefined();
    expect(cleanRepoDescription("🤖")).toBeUndefined();
  });
});

describe("defaultTryGoal", () => {
  const base = { owner: "facebook", name: "react" };

  it("uses the curated goal_pattern when present", () => {
    expect(defaultTryGoal({ ...base, goal_pattern: "build a UI" })).toBe(
      "Show me what facebook/react does and how to use it. Match: build a UI",
    );
  });

  it("falls back to the description, truncated at 160 chars", () => {
    expect(defaultTryGoal({ ...base, description: "A UI library" })).toBe(
      "Show me what facebook/react does and how to use it. Context: A UI library",
    );
    const long = defaultTryGoal({ ...base, description: "x".repeat(200) });
    expect(long.endsWith("…")).toBe(true);
    expect(long).toContain("x".repeat(157) + "…");
  });

  it("uses the bare head when there is neither", () => {
    expect(defaultTryGoal(base)).toBe("Show me what facebook/react does and how to use it.");
    expect(defaultTryGoal({ ...base, description: "  " })).toBe(
      "Show me what facebook/react does and how to use it.",
    );
  });
});
