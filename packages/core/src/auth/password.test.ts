import { describe, expect, it } from "vitest";
import {
  hashPassword,
  validatePasswordShape,
  verifyPassword,
} from "./password.js";

describe("hashPassword + verifyPassword", () => {
  it("verifies a freshly hashed password", async () => {
    const stored = await hashPassword("correct-horse-battery-staple");
    expect(stored.startsWith("scrypt$N=")).toBe(true);
    expect(await verifyPassword("correct-horse-battery-staple", stored)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const stored = await hashPassword("hello-world-1234");
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("produces a different hash each call (random salt)", async () => {
    const a = await hashPassword("samepassword");
    const b = await hashPassword("samepassword");
    expect(a).not.toBe(b);
    expect(await verifyPassword("samepassword", a)).toBe(true);
    expect(await verifyPassword("samepassword", b)).toBe(true);
  });

  it("returns false on malformed stored hash", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$N=16384$bad")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });
});

describe("validatePasswordShape", () => {
  it("rejects too-short", () => {
    expect(validatePasswordShape("short").ok).toBe(false);
  });
  it("accepts 8-char", () => {
    expect(validatePasswordShape("12345678").ok).toBe(true);
  });
  it("rejects empty", () => {
    expect(validatePasswordShape("").ok).toBe(false);
  });
  it("rejects 201-char", () => {
    expect(validatePasswordShape("a".repeat(201)).ok).toBe(false);
  });
  it("accepts 200-char (boundary)", () => {
    expect(validatePasswordShape("a".repeat(200)).ok).toBe(true);
  });
});
