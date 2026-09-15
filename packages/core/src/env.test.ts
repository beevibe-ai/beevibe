import { describe, expect, it } from "vitest";
import { readPositiveInt, resolveMcpServerUrl } from "./env.js";

describe("resolveMcpServerUrl", () => {
  it("prefers an explicit BEEVIBE_MCP_SERVER_URL", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "https://mcp.example.com/mcp",
        RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
      }),
    ).toBe("https://mcp.example.com/mcp");
  });

  it("derives the URL from RAILWAY_PUBLIC_DOMAIN so a one-click deploy works", () => {
    expect(resolveMcpServerUrl({ RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app" })).toBe(
      "https://app.up.railway.app/mcp",
    );
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveMcpServerUrl({})).toBeUndefined();
  });

  it.each([
    ["an empty explicit URL", { BEEVIBE_MCP_SERVER_URL: "" }],
    ["an empty domain", { RAILWAY_PUBLIC_DOMAIN: "" }],
  ])("treats %s as unset", (_label, env) => {
    expect(resolveMcpServerUrl(env)).toBeUndefined();
  });

  it("falls back to the domain when the explicit URL is empty", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "",
        RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
      }),
    ).toBe("https://app.up.railway.app/mcp");
  });

  it("reads a snapshot rather than the live process.env", () => {
    const snapshot = { BEEVIBE_MCP_SERVER_URL: "https://one.example/mcp" };
    const first = resolveMcpServerUrl(snapshot);
    process.env.BEEVIBE_MCP_SERVER_URL = "https://two.example/mcp";
    try {
      expect(resolveMcpServerUrl(snapshot)).toBe(first);
    } finally {
      delete process.env.BEEVIBE_MCP_SERVER_URL;
    }
  });
});

describe("readPositiveInt", () => {
  it("parses a positive integer", () => {
    expect(readPositiveInt("3000", 8080)).toBe(3000);
  });

  it.each([
    ["undefined", undefined],
    ["an empty string", ""],
  ])("falls back on %s", (_label, raw) => {
    // Number("") is 0, which would silently bind a server to a random port.
    expect(readPositiveInt(raw, 8080)).toBe(8080);
  });

  it.each([
    ["non-numeric text", "abc"],
    ["zero", "0"],
    ["a negative number", "-1"],
    ["whitespace", "   "],
  ])("falls back on %s", (_label, raw) => {
    expect(readPositiveInt(raw, 8080)).toBe(8080);
  });

  it("truncates a decimal to its integer part", () => {
    expect(readPositiveInt("3000.9", 8080)).toBe(3000);
  });

  it("takes the leading integer of a trailing-garbage value", () => {
    // parseInt semantics — "3000abc" is a misconfiguration, but binding
    // 3000 beats falling back to a different port silently.
    expect(readPositiveInt("3000abc", 8080)).toBe(3000);
  });

  it("returns the fallback verbatim, including an unusual one", () => {
    expect(readPositiveInt(undefined, 0)).toBe(0);
  });
});
