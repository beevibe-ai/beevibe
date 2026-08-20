import { describe, expect, it } from "vitest";
import { WORK_PRODUCT_TYPES, type WorkProductType } from "./work-product.js";

describe("WORK_PRODUCT_TYPES", () => {
  it("lists every WorkProductType exactly once", () => {
    // If a new variant is added to the WorkProductType union without
    // updating the runtime tuple, the tuple's compile-time width won't
    // match the union — this assertion pins the two together at runtime.
    expect(new Set(WORK_PRODUCT_TYPES).size).toBe(WORK_PRODUCT_TYPES.length);

    const expected: readonly WorkProductType[] = [
      "pull_request",
      "branch",
      "commit",
      "document",
      "analysis",
      "report",
      "design",
      "artifact",
      "preview",
    ];
    expect(new Set(WORK_PRODUCT_TYPES)).toEqual(new Set(expected));
    expect(WORK_PRODUCT_TYPES.length).toBe(expected.length);
  });

  it("preserves declaration order (matches the DB CHECK constraint enum ordering)", () => {
    expect([...WORK_PRODUCT_TYPES]).toEqual([
      "pull_request",
      "branch",
      "commit",
      "document",
      "analysis",
      "report",
      "design",
      "artifact",
      "preview",
    ]);
  });
});
