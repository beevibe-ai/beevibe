import { describe, expect, it } from "vitest";
import {
  coerceString,
  enumArg,
  nonEmptyString,
  oneOfMessage,
  optionalNumber,
  optionalObject,
  optionalString,
} from "./input.js";

describe("coerceString", () => {
  it("reads a string arg back verbatim", () => {
    expect(coerceString({ task_id: "task_abc" }, "task_id")).toBe("task_abc");
  });

  it("returns the empty string for a missing or null arg", () => {
    expect(coerceString({}, "task_id")).toBe("");
    expect(coerceString({ task_id: null }, "task_id")).toBe("");
    expect(coerceString({ task_id: undefined }, "task_id")).toBe("");
  });

  it("coerces a non-string — the contract that separates it from optionalString", () => {
    expect(coerceString({ limit: 123 }, "limit")).toBe("123");
    expect(optionalString({ limit: 123 }, "limit")).toBeUndefined();
  });

  it("trims only when asked", () => {
    expect(coerceString({ q: "  hi  " }, "q")).toBe("  hi  ");
    expect(coerceString({ q: "  hi  " }, "q", { trim: true })).toBe("hi");
  });
});

describe("optionalString", () => {
  it("passes an empty string through", () => {
    expect(optionalString({ url: "" }, "url")).toBe("");
  });

  it("trims without turning a blank value into undefined", () => {
    expect(optionalString({ url: "   " }, "url", { trim: true })).toBe("");
  });

  it("rejects non-strings", () => {
    expect(optionalString({ url: 5 }, "url")).toBeUndefined();
    expect(optionalString({ url: null }, "url")).toBeUndefined();
    expect(optionalString({}, "url")).toBeUndefined();
  });
});

describe("nonEmptyString", () => {
  it("treats an empty string as absent", () => {
    expect(nonEmptyString({ reason: "" }, "reason")).toBeUndefined();
  });

  it("treats a whitespace-only value as absent when trimming", () => {
    expect(nonEmptyString({ reason: "  " }, "reason", { trim: true })).toBeUndefined();
    // Without trim it is a non-empty string, so it survives.
    expect(nonEmptyString({ reason: "  " }, "reason")).toBe("  ");
  });

  it("returns the trimmed value", () => {
    expect(nonEmptyString({ reason: " late " }, "reason", { trim: true })).toBe("late");
  });
});

describe("optionalNumber", () => {
  it("returns the number when present", () => {
    expect(optionalNumber({ limit: 7 }, "limit")).toBe(7);
  });

  it("returns undefined with no fallback, and the fallback when given", () => {
    expect(optionalNumber({}, "limit")).toBeUndefined();
    expect(optionalNumber({}, "limit", 5)).toBe(5);
  });

  it("does not accept a numeric string", () => {
    expect(optionalNumber({ limit: "7" }, "limit", 5)).toBe(5);
  });
});

describe("optionalObject", () => {
  it("returns a plain object", () => {
    expect(optionalObject({ metadata: { pr: 12 } }, "metadata")).toEqual({ pr: 12 });
  });

  it("rejects an array — the case the two hand-written copies let through", () => {
    expect(optionalObject({ metadata: [] }, "metadata")).toBeUndefined();
    expect(optionalObject({ metadata: [1, 2] }, "metadata")).toBeUndefined();
  });

  it("rejects null and non-objects", () => {
    expect(optionalObject({ metadata: null }, "metadata")).toBeUndefined();
    expect(optionalObject({ metadata: "x" }, "metadata")).toBeUndefined();
    expect(optionalObject({}, "metadata")).toBeUndefined();
  });
});

describe("enumArg", () => {
  const ALLOWED = ["done", "failed", "blocked"] as const;

  it("returns a member of the set", () => {
    expect(enumArg({ status: "failed" }, "status", ALLOWED)).toBe("failed");
  });

  it("returns undefined for a non-member, a non-string, and an absent arg", () => {
    expect(enumArg({ status: "shipped" }, "status", ALLOWED)).toBeUndefined();
    expect(enumArg({ status: 1 }, "status", ALLOWED)).toBeUndefined();
    expect(enumArg({}, "status", ALLOWED)).toBeUndefined();
  });
});

describe("oneOfMessage", () => {
  it("renders the rejection prose the guards used to build inline", () => {
    expect(oneOfMessage("status", ["done", "failed"])).toBe(
      "status must be one of: done, failed",
    );
  });
});
