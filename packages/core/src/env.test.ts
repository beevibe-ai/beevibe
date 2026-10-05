import { describe, expect, it } from "vitest";
import { readPositiveInt, resolveMcpServerUrl } from "./env.js";

describe("resolveMcpServerUrl", () => {
  it("prefers an explicit BEEVIBE_MCP_SERVER_URL", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "https://beevibe.example/mcp",
        RAILWAY_PUBLIC_DOMAIN: "ignored.up.railway.app",
      }),
    ).toBe("https://beevibe.example/mcp");
  });

  it("derives the Railway URL when only the domain is set, so one-click deploys work unconfigured", () => {
    expect(
      resolveMcpServerUrl({ RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app" }),
    ).toBe("https://beevibe.up.railway.app/mcp");
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveMcpServerUrl({})).toBeUndefined();
  });

  it.each([
    ["an empty explicit url", { BEEVIBE_MCP_SERVER_URL: "" }],
    ["an empty railway domain", { RAILWAY_PUBLIC_DOMAIN: "" }],
  ])("treats %s as unset rather than building a bogus url", (_label, env) => {
    expect(resolveMcpServerUrl(env)).toBeUndefined();
  });

  it("falls through to Railway when the explicit url is empty", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "",
        RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app",
      }),
    ).toBe("https://beevibe.up.railway.app/mcp");
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
    // Number("") is 0, which would bind an HTTP server to a random
    // port — the whole reason this helper exists.
    expect(readPositiveInt(raw, 8080)).toBe(8080);
  });

  it.each([
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-1"],
    ["whitespace only", "   "],
  ])("falls back on a %s value", (_label, raw) => {
    expect(readPositiveInt(raw, 8080)).toBe(8080);
  });

  it("truncates a trailing-garbage value the way parseInt does", () => {
    expect(readPositiveInt("3000abc", 8080)).toBe(3000);
    expect(readPositiveInt("3000.9", 8080)).toBe(3000);
  });

  it("tolerates surrounding whitespace", () => {
    expect(readPositiveInt("  3000  ", 8080)).toBe(3000);
  });
});
