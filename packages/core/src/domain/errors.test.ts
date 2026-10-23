import { describe, expect, it } from "vitest";
import { asError, errorMessage } from "./errors.js";

describe("errorMessage", () => {
  it("takes an Error's own message", () => {
    expect(errorMessage(new Error("db hiccup"))).toBe("db hiccup");
  });

  it("keeps the message of an Error subclass", () => {
    class MeshCapacityError extends Error {}
    expect(errorMessage(new MeshCapacityError("at capacity"))).toBe("at capacity");
  });

  it("stringifies a thrown non-Error", () => {
    // Several call sites previously wrote `: err`, so a thrown object
    // reached console.error raw and printed as [object Object] while the
    // sites next to it printed something readable.
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("never returns a non-string", () => {
    for (const thrown of [new Error("x"), "y", 0, false, {}, []]) {
      expect(typeof errorMessage(thrown)).toBe("string");
    }
  });
});

describe("asError", () => {
  it("passes an Error through by identity so the stack survives", () => {
    const err = new Error("boom");
    expect(asError(err)).toBe(err);
  });

  it("passes an Error subclass through unwrapped", () => {
    class Custom extends Error {}
    const err = new Custom("boom");
    expect(asError(err)).toBe(err);
  });

  it("wraps a thrown non-Error, keeping its text as the message", () => {
    const wrapped = asError("not an error");
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe("not an error");
  });

  it("wraps nullish throwables rather than returning them", () => {
    expect(asError(undefined)).toBeInstanceOf(Error);
    expect(asError(null).message).toBe("null");
  });

  it("agrees with errorMessage on what the message is", () => {
    for (const thrown of [new Error("x"), "y", 7, null, undefined]) {
      expect(asError(thrown).message).toBe(errorMessage(thrown));
    }
  });
});
