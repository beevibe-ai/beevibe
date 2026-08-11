/**
 * Composition-root env helpers. Small, but both functions guard a
 * specific production footgun the JS defaults get wrong — the Railway
 * fallback and `Number("") === 0` — so the edge cases are pinned here.
 */
import { describe, expect, it } from "vitest";
import { readPositiveInt, resolveMcpServerUrl } from "./env.js";

describe("resolveMcpServerUrl", () => {
  it("prefers an explicit BEEVIBE_MCP_SERVER_URL", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "https://mcp.example.com/mcp",
        RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app",
      }),
    ).toBe("https://mcp.example.com/mcp");
  });

  it("derives the Railway URL when only the domain is set", () => {
    expect(resolveMcpServerUrl({ RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app" })).toBe(
      "https://beevibe.up.railway.app/mcp",
    );
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveMcpServerUrl({})).toBeUndefined();
  });

  it("treats an empty explicit URL as unset and falls through", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "",
        RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app",
      }),
    ).toBe("https://beevibe.up.railway.app/mcp");
  });

  it("returns undefined when both are empty", () => {
    expect(
      resolveMcpServerUrl({ BEEVIBE_MCP_SERVER_URL: "", RAILWAY_PUBLIC_DOMAIN: "" }),
    ).toBeUndefined();
  });
});

describe("readPositiveInt", () => {
  it("parses a positive integer", () => {
    expect(readPositiveInt("3000", 8080)).toBe(3000);
  });

  it.each([
    ["undefined", undefined],
    ["empty — Number('') would be 0 and bind a random port", ""],
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-1"],
  ])("falls back when the value is %s", (_label, raw) => {
    expect(readPositiveInt(raw, 8080)).toBe(8080);
  });

  it("truncates a decimal to its integer part", () => {
    expect(readPositiveInt("3000.9", 8080)).toBe(3000);
  });

  it("takes the leading integer of a trailing-garbage value", () => {
    // parseInt semantics, deliberately: "3000abc" is a typo'd port, not a
    // reason to silently fall back to a different one.
    expect(readPositiveInt("3000abc", 8080)).toBe(3000);
  });

  it("tolerates surrounding whitespace", () => {
    expect(readPositiveInt("  3000  ", 8080)).toBe(3000);
  });
});
