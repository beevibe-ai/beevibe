/**
 * `env.ts` is the composition-root's only env-parsing surface — both the
 * api and the scheduler binaries route through it before they bind a
 * port or hand agents an MCP URL. It had no test file at all, so the
 * Railway fallback and the `Number("")` guard the doc comments call out
 * were unverified.
 */

import { describe, expect, it } from "vitest";
import { readPositiveInt, resolveMcpServerUrl } from "./env.js";

describe("resolveMcpServerUrl", () => {
  it("prefers an explicit BEEVIBE_MCP_SERVER_URL", () => {
    expect(
      resolveMcpServerUrl({ BEEVIBE_MCP_SERVER_URL: "https://api.example.com/mcp" }),
    ).toBe("https://api.example.com/mcp");
  });

  // The explicit var wins even when a PaaS domain is also present —
  // otherwise an operator override would be silently ignored on Railway.
  it("prefers the explicit var over RAILWAY_PUBLIC_DOMAIN", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "https://explicit.example.com/mcp",
        RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app",
      }),
    ).toBe("https://explicit.example.com/mcp");
  });

  it("falls back to https://${RAILWAY_PUBLIC_DOMAIN}/mcp so a one-click deploy works", () => {
    expect(resolveMcpServerUrl({ RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app" })).toBe(
      "https://beevibe.up.railway.app/mcp",
    );
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveMcpServerUrl({})).toBeUndefined();
  });

  // An empty string is falsy, so it must behave like "unset" rather than
  // producing "https:///mcp" or an empty URL.
  it("treats empty strings as unset", () => {
    expect(resolveMcpServerUrl({ BEEVIBE_MCP_SERVER_URL: "" })).toBeUndefined();
    expect(
      resolveMcpServerUrl({ BEEVIBE_MCP_SERVER_URL: "", RAILWAY_PUBLIC_DOMAIN: "" }),
    ).toBeUndefined();
    expect(
      resolveMcpServerUrl({ BEEVIBE_MCP_SERVER_URL: "", RAILWAY_PUBLIC_DOMAIN: "d.example" }),
    ).toBe("https://d.example/mcp");
  });
});

describe("readPositiveInt", () => {
  it("parses a positive integer", () => {
    expect(readPositiveInt("8080", 3000)).toBe(8080);
  });

  it("falls back when undefined", () => {
    expect(readPositiveInt(undefined, 3000)).toBe(3000);
  });

  // The whole reason this helper exists: Number("") is 0, which would
  // bind an HTTP server to a random port instead of the intended one.
  it("falls back on the empty string rather than yielding 0", () => {
    expect(readPositiveInt("", 3000)).toBe(3000);
  });

  it("falls back on non-numeric input", () => {
    expect(readPositiveInt("not-a-port", 3000)).toBe(3000);
    expect(readPositiveInt("   ", 3000)).toBe(3000);
  });

  it("falls back on zero and negatives", () => {
    expect(readPositiveInt("0", 3000)).toBe(3000);
    expect(readPositiveInt("-1", 3000)).toBe(3000);
  });

  // parseInt stops at the first non-digit, which is the documented
  // behavior here — "8080abc" is a typo'd port, not a fallback case.
  it("takes parseInt's leading-digits reading of a trailing-garbage value", () => {
    expect(readPositiveInt("8080abc", 3000)).toBe(8080);
  });

  it("truncates a float to its integer part", () => {
    expect(readPositiveInt("8080.9", 3000)).toBe(8080);
  });
});
