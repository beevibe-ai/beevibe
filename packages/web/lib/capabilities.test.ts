import { describe, expect, it } from "vitest";
import {
  cleanRepoDescription,
  defaultTryGoal,
  formatStars,
  slugify,
} from "./capabilities";

describe("formatStars", () => {
  it("passes sub-1000 counts through verbatim", () => {
    expect(formatStars(0)).toBe("0");
    expect(formatStars(42)).toBe("42");
    expect(formatStars(999)).toBe("999");
  });

  it("shows one decimal in the 1k–9.9k range", () => {
    expect(formatStars(1234)).toBe("1.2k");
    expect(formatStars(1000)).toBe("1.0k");
    expect(formatStars(9949)).toBe("9.9k");
  });

  it("drops the decimal at 10k and above", () => {
    expect(formatStars(10000)).toBe("10k");
    expect(formatStars(18500)).toBe("19k");
    expect(formatStars(123456)).toBe("123k");
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates non-alphanumeric runs", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("Foo_Bar.Baz")).toBe("foo-bar-baz");
  });

  it("collapses repeated separators into a single hyphen", () => {
    expect(slugify("a   b---c")).toBe("a-b-c");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  spaced  ")).toBe("spaced");
    expect(slugify("!!!weird!!!")).toBe("weird");
  });

  it("caps the slug at 64 characters", () => {
    const long = "x".repeat(200);
    expect(slugify(long)).toHaveLength(64);
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("cleanRepoDescription", () => {
  it("returns undefined for nullish or empty input", () => {
    expect(cleanRepoDescription(null)).toBeUndefined();
    expect(cleanRepoDescription(undefined)).toBeUndefined();
    expect(cleanRepoDescription("")).toBeUndefined();
  });

  it("strips a leading emoji", () => {
    expect(cleanRepoDescription("🤖 Your AI assistant")).toBe("Your AI assistant");
  });

  it("strips a leading gemoji shortcode", () => {
    expect(cleanRepoDescription(":books: A reading list")).toBe("A reading list");
  });

  it("leaves a plain description untouched", () => {
    expect(cleanRepoDescription("A normal repo description")).toBe(
      "A normal repo description",
    );
  });

  it("returns undefined when only decoration remains", () => {
    expect(cleanRepoDescription("🤖")).toBeUndefined();
    expect(cleanRepoDescription("   ")).toBeUndefined();
  });
});

describe("defaultTryGoal", () => {
  const base = { owner: "acme", name: "widget" };
  const head = "Show me what acme/widget does and how to use it.";

  it("returns the bare head when no description or pattern is given", () => {
    expect(defaultTryGoal(base)).toBe(head);
  });

  it("appends a curated goal_pattern when present, ignoring description", () => {
    expect(
      defaultTryGoal({ ...base, goal_pattern: "build a CLI", description: "ignored" }),
    ).toBe(`${head} Match: build a CLI`);
  });

  it("appends the description as context when there is no pattern", () => {
    expect(defaultTryGoal({ ...base, description: "a widget library" })).toBe(
      `${head} Context: a widget library`,
    );
  });

  it("truncates an overlong description with an ellipsis at 157 chars", () => {
    const desc = "d".repeat(200);
    const goal = defaultTryGoal({ ...base, description: desc });
    expect(goal).toBe(`${head} Context: ${"d".repeat(157)}…`);
  });

  it("ignores a whitespace-only description", () => {
    expect(defaultTryGoal({ ...base, description: "   " })).toBe(head);
  });

  it("ignores a null description", () => {
    expect(defaultTryGoal({ ...base, description: null })).toBe(head);
  });
});
