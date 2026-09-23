import { describe, expect, it } from "vitest";
import {
  cleanRepoDescription,
  defaultTryGoal,
  formatStars,
  slugify,
} from "./capabilities";

/**
 * These four helpers exist because capabilities-client, chat-client,
 * run-detail-client and task-detail-client all render the same repo
 * rows. They were duplicated per-surface once and drifted; the tests
 * below pin the shared contract, especially the boundaries where the
 * old copies disagreed (the 1k/10k star thresholds and the 160-char
 * description cut).
 */

describe("formatStars", () => {
  it("leaves counts under 1000 alone", () => {
    expect(formatStars(0)).toBe("0");
    expect(formatStars(1)).toBe("1");
    expect(formatStars(999)).toBe("999");
  });

  it("uses one decimal between 1k and 10k", () => {
    expect(formatStars(1000)).toBe("1.0k");
    expect(formatStars(1234)).toBe("1.2k");
    expect(formatStars(9999)).toBe("10.0k");
  });

  it("drops the decimal at 10k and above", () => {
    expect(formatStars(10_000)).toBe("10k");
    expect(formatStars(18_500)).toBe("19k");
    expect(formatStars(200_000)).toBe("200k");
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Extract PDF Tables")).toBe("extract-pdf-tables");
  });

  it("collapses runs of non-alphanumerics into one hyphen", () => {
    expect(slugify("a  b__c///d")).toBe("a-b-c-d");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  hello  ")).toBe("hello");
    expect(slugify("!!!wrapped!!!")).toBe("wrapped");
  });

  it("keeps digits", () => {
    expect(slugify("ffmpeg 7 build")).toBe("ffmpeg-7-build");
  });

  it("caps the slug at 64 characters", () => {
    const slug = slugify("x".repeat(100));
    expect(slug).toHaveLength(64);
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("")).toBe("");
  });
});

describe("cleanRepoDescription", () => {
  it("returns undefined for absent or blank input", () => {
    expect(cleanRepoDescription(null)).toBeUndefined();
    expect(cleanRepoDescription(undefined)).toBeUndefined();
    expect(cleanRepoDescription("")).toBeUndefined();
    expect(cleanRepoDescription("   ")).toBeUndefined();
  });

  it("strips a leading emoji so rows align on text", () => {
    expect(cleanRepoDescription("🤖 Your AI assistant")).toBe("Your AI assistant");
  });

  it("strips a run of leading emoji and whitespace", () => {
    expect(cleanRepoDescription("  🚀✨  Fast things")).toBe("Fast things");
  });

  it("strips a leading gemoji shortcode", () => {
    expect(cleanRepoDescription(":books: A reading list")).toBe("A reading list");
  });

  it("leaves a plain description untouched apart from trimming", () => {
    expect(cleanRepoDescription("  Plumb a PDF  ")).toBe("Plumb a PDF");
  });

  it("keeps emoji that aren't at the start", () => {
    expect(cleanRepoDescription("Ship it 🚀")).toBe("Ship it 🚀");
  });

  it("returns undefined when the description was only decoration", () => {
    expect(cleanRepoDescription("🤖")).toBeUndefined();
    expect(cleanRepoDescription(":books:")).toBeUndefined();
  });
});

describe("defaultTryGoal", () => {
  const base = { owner: "jsvine", name: "pdfplumber" };
  const head = "Show me what jsvine/pdfplumber does and how to use it.";

  it("builds the bare head with no description or pattern", () => {
    expect(defaultTryGoal(base)).toBe(head);
  });

  it("appends a curated goal_pattern as Match", () => {
    expect(defaultTryGoal({ ...base, goal_pattern: "extract tables from PDFs" })).toBe(
      `${head} Match: extract tables from PDFs`,
    );
  });

  it("prefers the goal_pattern over the description", () => {
    // The /capabilities search variant has both; the learned pattern is
    // the more specific signal.
    expect(
      defaultTryGoal({
        ...base,
        goal_pattern: "extract tables",
        description: "Plumb a PDF",
      }),
    ).toBe(`${head} Match: extract tables`);
  });

  it("appends a description as Context when there's no pattern", () => {
    expect(defaultTryGoal({ ...base, description: "Plumb a PDF" })).toBe(
      `${head} Context: Plumb a PDF`,
    );
  });

  it("ignores a blank or absent description", () => {
    for (const description of ["", "   ", null, undefined]) {
      expect(defaultTryGoal({ ...base, description })).toBe(head);
    }
  });

  it("truncates a long description at 157 chars plus an ellipsis", () => {
    const goal = defaultTryGoal({ ...base, description: "d".repeat(300) });
    expect(goal).toBe(`${head} Context: ${"d".repeat(157)}…`);
  });

  it("leaves a description of exactly 160 chars intact", () => {
    const desc = "d".repeat(160);
    expect(defaultTryGoal({ ...base, description: desc })).toBe(
      `${head} Context: ${desc}`,
    );
  });
});
