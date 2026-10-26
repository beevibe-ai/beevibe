import { describe, expect, it } from "vitest";
import { readPositiveInt, resolveMcpServerUrl, type EnvSnapshot } from "./env.js";

describe("resolveMcpServerUrl", () => {
  it("prefers an explicit BEEVIBE_MCP_SERVER_URL", () => {
    expect(
      resolveMcpServerUrl({ BEEVIBE_MCP_SERVER_URL: "https://mcp.example.com/mcp" }),
    ).toBe("https://mcp.example.com/mcp");
  });

  it("wins over RAILWAY_PUBLIC_DOMAIN when both are set", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "https://explicit.example.com/mcp",
        RAILWAY_PUBLIC_DOMAIN: "fallback.up.railway.app",
      }),
    ).toBe("https://explicit.example.com/mcp");
  });

  it("derives the Railway URL so a one-click deploy needs no manual config", () => {
    expect(resolveMcpServerUrl({ RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app" })).toBe(
      "https://beevibe.up.railway.app/mcp",
    );
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveMcpServerUrl({})).toBeUndefined();
  });

  // An empty string is what a PaaS leaves behind for an unset-but-declared
  // var; treating it as present would hand the CLI "https:///mcp".
  it("treats an empty BEEVIBE_MCP_SERVER_URL as unset and falls through", () => {
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

  it("reads from a snapshot, not the live process.env", () => {
    const snapshot: EnvSnapshot = { RAILWAY_PUBLIC_DOMAIN: "snap.example.com" };
    const first = resolveMcpServerUrl(snapshot);
    // Mutating process.env must not change an already-captured snapshot's answer.
    process.env.BEEVIBE_MCP_SERVER_URL = "https://leaked.example.com/mcp";
    try {
      expect(resolveMcpServerUrl(snapshot)).toBe(first);
      expect(first).toBe("https://snap.example.com/mcp");
    } finally {
      delete process.env.BEEVIBE_MCP_SERVER_URL;
    }
  });
});

describe("readPositiveInt", () => {
  it("parses a positive integer", () => {
    expect(readPositiveInt("8080", 3000)).toBe(8080);
  });

  it("falls back when the var is missing", () => {
    expect(readPositiveInt(undefined, 3000)).toBe(3000);
  });

  // The documented trap: Number("") is 0, which binds an HTTP server to a
  // random port instead of the intended default.
  it("falls back on an empty string rather than yielding 0", () => {
    expect(readPositiveInt("", 3000)).toBe(3000);
  });

  it("falls back on a non-numeric value", () => {
    expect(readPositiveInt("not-a-port", 3000)).toBe(3000);
  });

  it("falls back on zero", () => {
    expect(readPositiveInt("0", 3000)).toBe(3000);
  });

  it("falls back on a negative value", () => {
    expect(readPositiveInt("-1", 3000)).toBe(3000);
  });

  it("falls back on NaN and Infinity spellings", () => {
    expect(readPositiveInt("NaN", 3000)).toBe(3000);
    expect(readPositiveInt("Infinity", 3000)).toBe(3000);
  });

  // parseInt stops at the first non-digit; "3000abc" is a typo'd port, but
  // the current contract accepts the numeric prefix. Pinned so a future
  // tightening to Number() is a deliberate, visible change.
  it("accepts a numeric prefix, per parseInt semantics", () => {
    expect(readPositiveInt("3000abc", 8080)).toBe(3000);
  });

  it("truncates a decimal to its integer part", () => {
    expect(readPositiveInt("3000.9", 8080)).toBe(3000);
  });

  it("tolerates surrounding whitespace", () => {
    expect(readPositiveInt("  3000  ", 8080)).toBe(3000);
  });

  it("returns the fallback verbatim, including 0 as a sentinel", () => {
    // scheduler/main.ts uses `readPositiveInt(x, 0) || undefined` to mean
    // "unset"; a 0 fallback has to survive.
    expect(readPositiveInt(undefined, 0)).toBe(0);
    expect(readPositiveInt("", 0)).toBe(0);
  });
});
