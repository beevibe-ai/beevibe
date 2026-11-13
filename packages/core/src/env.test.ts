/**
 * Composition-root env helpers. Both functions are pure over an
 * `EnvSnapshot`, and both guard a real deploy footgun:
 *
 *   - `resolveMcpServerUrl`'s Railway fallback is what makes a one-click
 *     deploy work without the operator setting BEEVIBE_MCP_SERVER_URL.
 *   - `readPositiveInt` exists because `Number("")` is 0, and a 0 port
 *     silently binds the HTTP server to a random one.
 */
import { describe, expect, it } from "vitest";

import { readPositiveInt, resolveMcpServerUrl } from "./env.js";

describe("resolveMcpServerUrl", () => {
  it("prefers an explicit BEEVIBE_MCP_SERVER_URL", () => {
    expect(
      resolveMcpServerUrl({ BEEVIBE_MCP_SERVER_URL: "https://mcp.example.com/mcp" }),
    ).toBe("https://mcp.example.com/mcp");
  });

  it("wins over the Railway domain when both are set", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "https://explicit.example.com/mcp",
        RAILWAY_PUBLIC_DOMAIN: "fallback.up.railway.app",
      }),
    ).toBe("https://explicit.example.com/mcp");
  });

  it("derives an https /mcp URL from RAILWAY_PUBLIC_DOMAIN", () => {
    expect(resolveMcpServerUrl({ RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app" })).toBe(
      "https://beevibe.up.railway.app/mcp",
    );
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveMcpServerUrl({})).toBeUndefined();
  });

  // An empty string is falsy, so it must fall through rather than
  // producing "https:///mcp" or an empty URL the CLIs would then POST to.
  it("treats an empty explicit URL as unset and falls through to Railway", () => {
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

  it("ignores unrelated keys on the snapshot", () => {
    expect(resolveMcpServerUrl({ DATABASE_URL: "postgres://x", PORT: "3000" })).toBeUndefined();
  });
});

describe("readPositiveInt", () => {
  it("parses a plain positive integer", () => {
    expect(readPositiveInt("8080", 3000)).toBe(8080);
  });

  it("falls back when undefined", () => {
    expect(readPositiveInt(undefined, 3000)).toBe(3000);
  });

  // The documented reason this function exists: Number("") === 0, which
  // would bind the server to a random port instead of the default.
  it("falls back on an empty string rather than yielding 0", () => {
    expect(readPositiveInt("", 3000)).toBe(3000);
  });

  it("falls back on non-numeric input", () => {
    expect(readPositiveInt("not-a-port", 3000)).toBe(3000);
  });

  it("falls back on a whitespace-only string", () => {
    expect(readPositiveInt("   ", 3000)).toBe(3000);
  });

  it("falls back on zero", () => {
    expect(readPositiveInt("0", 3000)).toBe(3000);
  });

  it("falls back on a negative value", () => {
    expect(readPositiveInt("-1", 3000)).toBe(3000);
  });

  // parseInt stops at the first non-digit, so "3000abc" is 3000. That is
  // the intended lenient behavior — lock it so a stricter rewrite has to
  // be deliberate.
  it("takes the leading digits of a mixed string", () => {
    expect(readPositiveInt("3000abc", 8080)).toBe(3000);
  });

  it("truncates a decimal toward zero", () => {
    expect(readPositiveInt("3000.9", 8080)).toBe(3000);
  });

  it("tolerates surrounding whitespace around digits", () => {
    expect(readPositiveInt("  8080  ", 3000)).toBe(8080);
  });

  it("falls back on Infinity, which is not a finite port", () => {
    expect(readPositiveInt("Infinity", 3000)).toBe(3000);
  });

  it("returns the fallback unchanged even when the fallback is itself odd", () => {
    expect(readPositiveInt(undefined, 0)).toBe(0);
  });
});
