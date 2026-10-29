/**
 * Composition-root env helpers. Both functions guard a deploy-time
 * footgun, so the edges are the point: `resolveMcpServerUrl`'s Railway
 * fallback is what makes a one-click deploy work without manual config,
 * and `readPositiveInt` exists because `Number("")` is 0 — which would
 * bind an HTTP server to a random port instead of its default.
 */
import { describe, expect, it } from "vitest";
import { readPositiveInt, resolveMcpServerUrl } from "./env.js";

describe("resolveMcpServerUrl", () => {
  it("prefers an explicit BEEVIBE_MCP_SERVER_URL over the Railway fallback", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "https://mcp.example.com/mcp",
        RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app",
      }),
    ).toBe("https://mcp.example.com/mcp");
  });

  it("derives the /mcp URL from RAILWAY_PUBLIC_DOMAIN when no explicit URL is set", () => {
    expect(resolveMcpServerUrl({ RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app" })).toBe(
      "https://beevibe.up.railway.app/mcp",
    );
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveMcpServerUrl({})).toBeUndefined();
  });

  it("treats an empty explicit URL as unset and falls through to Railway", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "",
        RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app",
      }),
    ).toBe("https://beevibe.up.railway.app/mcp");
  });

  it("returns undefined when both vars are present but empty", () => {
    expect(
      resolveMcpServerUrl({ BEEVIBE_MCP_SERVER_URL: "", RAILWAY_PUBLIC_DOMAIN: "" }),
    ).toBeUndefined();
  });
});

describe("readPositiveInt", () => {
  it("parses a positive integer", () => {
    expect(readPositiveInt("8080", 3000)).toBe(8080);
  });

  it("falls back when the var is missing", () => {
    expect(readPositiveInt(undefined, 3000)).toBe(3000);
  });

  it("falls back on the empty string rather than letting Number('') yield 0", () => {
    expect(readPositiveInt("", 3000)).toBe(3000);
  });

  it("falls back on a non-numeric value", () => {
    expect(readPositiveInt("not-a-port", 3000)).toBe(3000);
  });

  it("falls back on zero and on negatives", () => {
    expect(readPositiveInt("0", 3000)).toBe(3000);
    expect(readPositiveInt("-1", 3000)).toBe(3000);
  });

  it("truncates a trailing-garbage value the way parseInt does", () => {
    expect(readPositiveInt("8080abc", 3000)).toBe(8080);
  });

  it("floors a decimal string to its integer part", () => {
    expect(readPositiveInt("25.9", 3000)).toBe(25);
  });
});
