/**
 * Capability-network display helpers.
 *
 * These exist specifically to be the single copy shared by
 * capabilities-client, chat-client, run-detail-client and
 * task-detail-client — four surfaces that used to each carry their own
 * drifting `defaultTryGoal` / `formatStars`. Pinning the behaviour here
 * is what keeps them from drifting again.
 */
import { describe, expect, it } from "vitest";
import {
  cleanRepoDescription,
  defaultTryGoal,
  formatStars,
  slugify,
} from "./capabilities";

describe("formatStars", () => {
  it.each([
    [0, "0"],
    [1, "1"],
    [999, "999"],
    // The k-suffix kicks in at 1000, with one decimal below 10k...
    [1000, "1.0k"],
    [1234, "1.2k"],
    [9999, "10.0k"],
    // ...and none at or above it, so the row stays narrow.
    [10_000, "10k"],
    [18_500, "19k"],
    [123_456, "123k"],
  ])("%s → %s", (input, expected) => {
    expect(formatStars(input)).toBe(expected);
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates runs of non-alphanumerics", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("yt-dlp / audio extractor")).toBe("yt-dlp-audio-extractor");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  !Leading and trailing!  ")).toBe("leading-and-trailing");
  });

  it("keeps digits", () => {
    expect(slugify("PDF2JSON v3")).toBe("pdf2json-v3");
  });

  it("caps the slug at 64 characters", () => {
    const slug = slugify("a".repeat(200));
    expect(slug).toHaveLength(64);
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("")).toBe("");
  });
});

describe("cleanRepoDescription", () => {
  it("strips a leading emoji so rows align on text", () => {
    expect(cleanRepoDescription("🤖 Your AI assistant")).toBe("Your AI assistant");
  });

  it("strips a run of leading emoji and whitespace", () => {
    expect(cleanRepoDescription("  🚀✨  Fast things")).toBe("Fast things");
  });

  it("strips a leading gemoji shortcode", () => {
    expect(cleanRepoDescription(":books: A reading list")).toBe("A reading list");
  });

  it("leaves a plain description alone apart from trimming", () => {
    expect(cleanRepoDescription("  A plain description  ")).toBe("A plain description");
  });

  it("keeps emoji that are not at the front", () => {
    expect(cleanRepoDescription("Ship it 🚀")).toBe("Ship it 🚀");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["emoji only", "🤖"],
  ])("returns undefined for %s so the row renders no description", (_label, input) => {
    expect(cleanRepoDescription(input)).toBeUndefined();
  });
});

describe("defaultTryGoal", () => {
  const repo = { owner: "yt-dlp", name: "yt-dlp" };

  it("builds the bare head when there is nothing else to add", () => {
    expect(defaultTryGoal(repo)).toBe(
      "Show me what yt-dlp/yt-dlp does and how to use it.",
    );
  });

  it("prefers a learned goal_pattern over the description", () => {
    expect(
      defaultTryGoal({ ...repo, goal_pattern: "download audio", description: "ignored" }),
    ).toBe(
      "Show me what yt-dlp/yt-dlp does and how to use it. Match: download audio",
    );
  });

  it("falls back to the description as context", () => {
    expect(defaultTryGoal({ ...repo, description: "  A video downloader  " })).toBe(
      "Show me what yt-dlp/yt-dlp does and how to use it. Context: A video downloader",
    );
  });

  it("truncates a long description to keep the goal prompt-sized", () => {
    const goal = defaultTryGoal({ ...repo, description: "x".repeat(300) });
    expect(goal).toContain("Context: " + "x".repeat(157) + "…");
  });

  it("keeps a description exactly at the 160-char limit verbatim", () => {
    const desc = "y".repeat(160);
    expect(defaultTryGoal({ ...repo, description: desc })).toContain(`Context: ${desc}`);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["whitespace only", "   "],
  ])("omits the context clause for a %s description", (_label, description) => {
    expect(defaultTryGoal({ ...repo, description })).toBe(
      "Show me what yt-dlp/yt-dlp does and how to use it.",
    );
  });
});
