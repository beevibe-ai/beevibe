import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors.js";

describe("errorMessage", () => {
  it("returns an Error's message without the class-name prefix", () => {
    // The distinction from bare String(err), which would yield "Error: boom".
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("keeps the message of an Error subclass", () => {
    class HttpError extends Error {}
    expect(errorMessage(new HttpError("404 not found"))).toBe("404 not found");
  });

  it("stringifies a thrown non-Error", () => {
    expect(errorMessage("plain string throw")).toBe("plain string throw");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage({ code: "E" })).toBe("[object Object]");
  });

  it("stringifies null and undefined rather than throwing", () => {
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(null)).toBe("null");
  });
});
