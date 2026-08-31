import { describe, expect, it } from "vitest";
import {
  missingArgs,
  optionalNonEmptyString,
  optionalNumber,
  optionalObject,
  optionalString,
  optionalStringArray,
  optionalTrimmedString,
  stringArg,
  trimmedArg,
} from "./input.js";

describe("stringArg", () => {
  it("reads a string arg", () => {
    expect(stringArg({ task_id: "task_1" }, "task_id")).toBe("task_1");
  });

  it("yields the empty string for absent and null, which is what callers guard on", () => {
    expect(stringArg({}, "task_id")).toBe("");
    expect(stringArg({ task_id: null }, "task_id")).toBe("");
  });

  it("coerces a non-string rather than rejecting it", () => {
    // `String(input.x ?? "")` is what every call site did, and models do
    // send bare numbers for id-shaped args. Tightening this to a
    // `typeof` check would start rejecting calls that work today, so
    // the coercion is pinned deliberately.
    expect(stringArg({ task_id: 5 }, "task_id")).toBe("5");
    expect(stringArg({ task_id: false }, "task_id")).toBe("false");
  });

  it("does not trim — a padded value stays padded", () => {
    expect(stringArg({ q: "  hi  " }, "q")).toBe("  hi  ");
  });
});

describe("trimmedArg", () => {
  it("strips surrounding whitespace", () => {
    expect(trimmedArg({ name: "  Ada  " }, "name")).toBe("Ada");
  });

  it("collapses a whitespace-only value to empty, so the caller's guard fires", () => {
    expect(trimmedArg({ name: "   " }, "name")).toBe("");
  });
});

describe("missingArgs", () => {
  it("names a single arg", () => {
    expect(missingArgs("task_id")).toEqual({
      content: { error: "task_id required" },
      isError: true,
    });
  });

  it("joins a pair with 'and', matching the existing wire messages", () => {
    expect(missingArgs("task_id", "feedback").content).toEqual({
      error: "task_id and feedback required",
    });
  });

  it("comma-separates three or more", () => {
    expect(missingArgs("a", "b", "c").content).toEqual({ error: "a, b and c required" });
  });

  it("always marks the result as an error", () => {
    expect(missingArgs("id").isError).toBe(true);
  });
});

describe("optionalString", () => {
  it("passes a string through verbatim, empty included", () => {
    expect(optionalString({ url: "https://x" }, "url")).toBe("https://x");
    expect(optionalString({ url: "" }, "url")).toBe("");
  });

  it("is undefined for absent or non-string", () => {
    expect(optionalString({}, "url")).toBeUndefined();
    expect(optionalString({ url: 7 }, "url")).toBeUndefined();
    expect(optionalString({ url: null }, "url")).toBeUndefined();
  });
});

describe("optionalNonEmptyString", () => {
  it("rejects the empty string where optionalString would keep it", () => {
    expect(optionalNonEmptyString({ repo_url: "" }, "repo_url")).toBeUndefined();
    expect(optionalString({ repo_url: "" }, "repo_url")).toBe("");
  });

  it("keeps a whitespace-only value verbatim — it does not trim", () => {
    // This is the difference from optionalTrimmedString, and the reason
    // both exist rather than one with a flag.
    expect(optionalNonEmptyString({ repo_url: "  " }, "repo_url")).toBe("  ");
    expect(optionalTrimmedString({ repo_url: "  " }, "repo_url")).toBeUndefined();
  });
});

describe("optionalTrimmedString", () => {
  it("returns the trimmed value", () => {
    expect(optionalTrimmedString({ q: "  hello  " }, "q")).toBe("hello");
  });

  it("is undefined for absent, non-string, empty and whitespace-only", () => {
    expect(optionalTrimmedString({}, "q")).toBeUndefined();
    expect(optionalTrimmedString({ q: 3 }, "q")).toBeUndefined();
    expect(optionalTrimmedString({ q: "" }, "q")).toBeUndefined();
    expect(optionalTrimmedString({ q: "\t \n" }, "q")).toBeUndefined();
  });
});

describe("optionalNumber", () => {
  it("passes a number through, zero included", () => {
    expect(optionalNumber({ limit: 10 }, "limit")).toBe(10);
    expect(optionalNumber({ limit: 0 }, "limit")).toBe(0);
  });

  it("does not coerce a numeric string", () => {
    expect(optionalNumber({ limit: "10" }, "limit")).toBeUndefined();
  });
});

describe("optionalStringArray", () => {
  it("keeps the string elements", () => {
    expect(optionalStringArray({ ids: ["a", "b"] }, "ids")).toEqual(["a", "b"]);
  });

  it("drops non-string elements rather than rejecting the call", () => {
    expect(optionalStringArray({ ids: ["a", 1, null, "b"] }, "ids")).toEqual(["a", "b"]);
  });

  it("distinguishes 'not supplied' from 'supplied empty'", () => {
    // watch_tasks defaults to [] and then rejects on length; the
    // escalation tools leave the slot unset. Both need this gap.
    expect(optionalStringArray({}, "ids")).toBeUndefined();
    expect(optionalStringArray({ ids: [] }, "ids")).toEqual([]);
  });

  it("is undefined for a non-array", () => {
    expect(optionalStringArray({ ids: "a" }, "ids")).toBeUndefined();
  });
});

describe("optionalObject", () => {
  it("passes an object bag through", () => {
    expect(optionalObject({ metadata: { pr: 12 } }, "metadata")).toEqual({ pr: 12 });
  });

  it("is undefined for absent, null and primitives", () => {
    expect(optionalObject({}, "metadata")).toBeUndefined();
    expect(optionalObject({ metadata: null }, "metadata")).toBeUndefined();
    expect(optionalObject({ metadata: "x" }, "metadata")).toBeUndefined();
    expect(optionalObject({ metadata: 0 }, "metadata")).toBeUndefined();
  });

  it("lets an array through, as both call sites already did", () => {
    // Pinned as existing behavior, not endorsed: `typeof [] === "object"`.
    // Whether create_work_product should accept an array as `metadata`
    // is a separate call from the refactor that introduced this helper.
    expect(optionalObject({ metadata: [1] }, "metadata")).toEqual([1]);
  });
});
