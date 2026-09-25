import { describe, expect, it } from "vitest";
import {
  cleanRepoDescription,
  defaultTryGoal,
  formatStars,
  slugify,
} from "./capabilities";

describe("formatStars", () => {
  it("leaves counts under 1000 as plain digits", () => {
    expect(formatStars(0)).toBe("0");
    expect(formatStars(7)).toBe("7");
    expect(formatStars(999)).toBe("999");
  });

  it("switches to one decimal 'k' from 1000", () => {
    expect(formatStars(1000)).toBe("1.0k");
    expect(formatStars(1234)).toBe("1.2k");
    expect(formatStars(9949)).toBe("9.9k");
  });

  it("drops the decimal from 10000 up", () => {
    expect(formatStars(10_000)).toBe("10k");
    expect(formatStars(18_500)).toBe("19k");
    expect(formatStars(123_456)).toBe("123k");
  });
});

describe("slugify", () => {
  it("lowercases and collapses runs of non-alphanumerics to single dashes", () => {
    expect(slugify("Extract Tables — From PDFs!")).toBe("extract-tables-from-pdfs");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("  !hello world!  ")).toBe("hello-world");
    expect(slugify("---")).toBe("");
  });

  it("keeps digits", () => {
    expect(slugify("pdfplumber v0.11")).toBe("pdfplumber-v0-11");
  });

  it("caps the result at 64 characters", () => {
    const out = slugify("a".repeat(100));
    expect(out).toHaveLength(64);
  });
});

describe("cleanRepoDescription", () => {
  it("returns undefined for empty, null and undefined input", () => {
    expect(cleanRepoDescription(undefined)).toBeUndefined();
    expect(cleanRepoDescription(null)).toBeUndefined();
    expect(cleanRepoDescription("")).toBeUndefined();
  });

  it("strips a leading emoji and the whitespace after it", () => {
    expect(cleanRepoDescription("🤖 Your AI assistant")).toBe("Your AI assistant");
    expect(cleanRepoDescription("  🚀🔥 Fast things ")).toBe("Fast things");
  });

  it("strips a leading gemoji shortcode", () => {
    expect(cleanRepoDescription(":books: A reading list")).toBe("A reading list");
  });

  it("leaves emoji that are not leading alone", () => {
    expect(cleanRepoDescription("Plots charts 📈")).toBe("Plots charts 📈");
  });

  it("returns undefined when stripping leaves nothing", () => {
    expect(cleanRepoDescription("🤖")).toBeUndefined();
    expect(cleanRepoDescription("   ")).toBeUndefined();
  });
});

describe("defaultTryGoal", () => {
  const repo = { owner: "jsvine", name: "pdfplumber" };
  const head = "Show me what jsvine/pdfplumber does and how to use it.";

  it("returns the bare head when there is no description or goal_pattern", () => {
    expect(defaultTryGoal(repo)).toBe(head);
    expect(defaultTryGoal({ ...repo, description: null })).toBe(head);
    expect(defaultTryGoal({ ...repo, description: "   " })).toBe(head);
  });

  it("prefers the curated goal_pattern over the description", () => {
    expect(
      defaultTryGoal({ ...repo, description: "Plumb PDFs", goal_pattern: "extract tables" }),
    ).toBe(`${head} Match: extract tables`);
  });

  it("appends a trimmed description as context", () => {
    expect(defaultTryGoal({ ...repo, description: "  Plumb PDFs  " })).toBe(
      `${head} Context: Plumb PDFs`,
    );
  });

  it("truncates a long description to 157 chars plus an ellipsis", () => {
    const goal = defaultTryGoal({ ...repo, description: "x".repeat(200) });
    expect(goal).toBe(`${head} Context: ${"x".repeat(157)}…`);
  });

  it("leaves a description of exactly 160 chars untruncated", () => {
    const desc = "y".repeat(160);
    expect(defaultTryGoal({ ...repo, description: desc })).toBe(`${head} Context: ${desc}`);
  });
});
