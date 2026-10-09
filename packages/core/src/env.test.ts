/**
 * Composition-root env helpers. Both are pure, and both guard a trap
 * that bit us before: the Railway fallback (a one-click deploy has no
 * BEEVIBE_MCP_SERVER_URL) and `Number("")` returning 0, which would
 * silently bind the HTTP server to a random port.
 */
import { describe, expect, it } from "vitest";
import { readPositiveInt, resolveMcpServerUrl } from "./env.js";

describe("resolveMcpServerUrl", () => {
  it("prefers an explicit BEEVIBE_MCP_SERVER_URL", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "https://explicit.example.com/mcp",
        RAILWAY_PUBLIC_DOMAIN: "ignored.railway.app",
      }),
    ).toBe("https://explicit.example.com/mcp");
  });

  it("derives the Railway URL when only the domain is set", () => {
    expect(resolveMcpServerUrl({ RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app" })).toBe(
      "https://beevibe.up.railway.app/mcp",
    );
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveMcpServerUrl({})).toBeUndefined();
  });

  it("treats an empty explicit URL as unset and falls back to Railway", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "",
        RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app",
      }),
    ).toBe("https://beevibe.up.railway.app/mcp");
  });

  it("returns undefined when both vars are empty strings", () => {
    expect(
      resolveMcpServerUrl({ BEEVIBE_MCP_SERVER_URL: "", RAILWAY_PUBLIC_DOMAIN: "" }),
    ).toBeUndefined();
  });
});

describe("readPositiveInt", () => {
  it("parses a positive integer", () => {
    expect(readPositiveInt("3000", 8080)).toBe(3000);
  });

  it("falls back on undefined", () => {
    expect(readPositiveInt(undefined, 8080)).toBe(8080);
  });

  it("falls back on an empty string rather than yielding Number('') === 0", () => {
    // The whole reason this helper exists: a port of 0 binds a random one.
    expect(readPositiveInt("", 8080)).toBe(8080);
  });

  it("falls back on non-numeric input", () => {
    expect(readPositiveInt("abc", 8080)).toBe(8080);
    expect(readPositiveInt("  ", 8080)).toBe(8080);
  });

  it("falls back on zero and negatives", () => {
    expect(readPositiveInt("0", 8080)).toBe(8080);
    expect(readPositiveInt("-1", 8080)).toBe(8080);
  });

  it("truncates a decimal to its integer part via parseInt", () => {
    expect(readPositiveInt("3000.9", 8080)).toBe(3000);
  });

  it("accepts a trailing-garbage numeric prefix the way parseInt does", () => {
    // Documents parseInt's lenience: "3000abc" is a typo we'd rather
    // honor as 3000 than silently swap for the fallback.
    expect(readPositiveInt("3000abc", 8080)).toBe(3000);
  });

  it("falls back on Infinity, which parseInt cannot represent", () => {
    expect(readPositiveInt("Infinity", 8080)).toBe(8080);
  });
});
