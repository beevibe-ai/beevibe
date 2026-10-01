import { describe, expect, it } from "vitest";
import { cleanRepoDescription, defaultTryGoal, formatStars, slugify } from "./capabilities";

describe("formatStars", () => {
  it("leaves sub-1k counts bare", () => {
    expect(formatStars(0)).toBe("0");
    expect(formatStars(999)).toBe("999");
  });

  it("uses one decimal between 1k and 10k", () => {
    expect(formatStars(1000)).toBe("1.0k");
    expect(formatStars(1234)).toBe("1.2k");
    expect(formatStars(9999)).toBe("10.0k");
  });

  it("drops the decimal at 10k and above", () => {
    expect(formatStars(10000)).toBe("10k");
    expect(formatStars(18500)).toBe("19k");
    expect(formatStars(1_200_000)).toBe("1200k");
  });
});

describe("slugify", () => {
  it("lowercases and collapses runs of non-alphanumerics to single dashes", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("Foo___Bar !! Baz")).toBe("foo-bar-baz");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("  spaced  ")).toBe("spaced");
    expect(slugify("!!!edges!!!")).toBe("edges");
  });

  it("caps the slug at 64 chars", () => {
    const out = slugify("a".repeat(100));
    expect(out).toHaveLength(64);
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("")).toBe("");
  });
});

describe("cleanRepoDescription", () => {
  it("returns undefined for missing or blank input", () => {
    expect(cleanRepoDescription(null)).toBeUndefined();
    expect(cleanRepoDescription(undefined)).toBeUndefined();
    expect(cleanRepoDescription("")).toBeUndefined();
    expect(cleanRepoDescription("   ")).toBeUndefined();
  });

  it("strips a leading emoji", () => {
    expect(cleanRepoDescription("🤖 Your AI assistant")).toBe("Your AI assistant");
    expect(cleanRepoDescription("📚📖 Docs")).toBe("Docs");
  });

  it("strips a leading gemoji shortcode", () => {
    expect(cleanRepoDescription(":books: A reading list")).toBe("A reading list");
  });

  it("keeps emoji that are not in the leading position", () => {
    expect(cleanRepoDescription("Ship it 🚀")).toBe("Ship it 🚀");
  });

  it("returns undefined when the description was only a leader", () => {
    expect(cleanRepoDescription("🤖")).toBeUndefined();
  });
});

describe("defaultTryGoal", () => {
  const base = { owner: "anthropics", name: "claude-code" };
  const head = "Show me what anthropics/claude-code does and how to use it.";

  it("returns the bare head with no description or pattern", () => {
    expect(defaultTryGoal(base)).toBe(head);
    expect(defaultTryGoal({ ...base, description: null })).toBe(head);
    expect(defaultTryGoal({ ...base, description: "   " })).toBe(head);
  });

  it("prefers a curated goal_pattern over the description", () => {
    expect(
      defaultTryGoal({ ...base, description: "An agentic CLI", goal_pattern: "review a diff" }),
    ).toBe(`${head} Match: review a diff`);
  });

  it("appends a short description as context", () => {
    expect(defaultTryGoal({ ...base, description: "  An agentic CLI  " })).toBe(
      `${head} Context: An agentic CLI`,
    );
  });

  it("truncates a long description with an ellipsis", () => {
    const long = "x".repeat(200);
    const out = defaultTryGoal({ ...base, description: long });
    expect(out).toBe(`${head} Context: ${"x".repeat(157)}…`);
  });

  it("leaves a description at the 160-char boundary intact", () => {
    const exact = "y".repeat(160);
    expect(defaultTryGoal({ ...base, description: exact })).toBe(`${head} Context: ${exact}`);
  });
});
