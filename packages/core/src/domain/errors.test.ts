import { describe, it, expect } from "vitest";
import { errorMessage, toError } from "./errors.js";

describe("errorMessage", () => {
  it("returns an Error's message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error throw", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("prefers the fallback over stringification for non-Errors", () => {
    expect(errorMessage({ status: 500 }, "Save failed")).toBe("Save failed");
  });

  it("ignores the fallback when the value IS an Error", () => {
    expect(errorMessage(new Error("boom"), "Save failed")).toBe("boom");
  });

  it("keeps an Error subclass's message", () => {
    class CodedError extends Error {
      constructor(readonly code: string) {
        super(`failed: ${code}`);
      }
    }
    expect(errorMessage(new CodedError("nope"))).toBe("failed: nope");
  });

  it("does not throw on a value whose toString is exotic", () => {
    expect(errorMessage(Symbol("x").toString())).toBe("Symbol(x)");
  });
});

describe("toError", () => {
  it("passes an Error through by identity", () => {
    const err = new Error("boom");
    expect(toError(err)).toBe(err);
  });

  it("preserves an Error subclass instance rather than re-wrapping", () => {
    class CodedError extends Error {}
    const err = new CodedError("boom");
    expect(toError(err)).toBe(err);
    expect(toError(err)).toBeInstanceOf(CodedError);
  });

  it("wraps a non-Error with its stringification as the message", () => {
    const wrapped = toError("plain string");
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe("plain string");
  });
});
