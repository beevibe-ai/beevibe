import { describe, expect, it } from "vitest";
import { readPositiveInt, resolveMcpServerUrl } from "./env.js";

describe("resolveMcpServerUrl", () => {
  it("prefers an explicit BEEVIBE_MCP_SERVER_URL", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "http://localhost:3000/mcp",
        RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app",
      }),
    ).toBe("http://localhost:3000/mcp");
  });

  it("derives the Railway URL when only the public domain is set", () => {
    expect(
      resolveMcpServerUrl({ RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app" }),
    ).toBe("https://beevibe.up.railway.app/mcp");
  });

  it("returns undefined when neither var is usable", () => {
    expect(resolveMcpServerUrl({})).toBeUndefined();
    // Empty strings are falsy — an operator who set the var to "" gets
    // the same "unconfigured" answer rather than "https:///mcp".
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "",
        RAILWAY_PUBLIC_DOMAIN: "",
      }),
    ).toBeUndefined();
  });

  it("falls through an empty explicit URL to the Railway domain", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "",
        RAILWAY_PUBLIC_DOMAIN: "x.railway.app",
      }),
    ).toBe("https://x.railway.app/mcp");
  });
});

describe("readPositiveInt", () => {
  it("parses a positive integer", () => {
    expect(readPositiveInt("3000", 8080)).toBe(3000);
  });

  it("falls back on undefined and on empty string", () => {
    // Number("") is 0, which would silently bind a server to a random
    // port — the guard this function exists for.
    expect(readPositiveInt(undefined, 8080)).toBe(8080);
    expect(readPositiveInt("", 8080)).toBe(8080);
  });

  it("falls back on non-numeric, zero, and negative input", () => {
    expect(readPositiveInt("abc", 8080)).toBe(8080);
    expect(readPositiveInt("0", 8080)).toBe(8080);
    expect(readPositiveInt("-1", 8080)).toBe(8080);
    expect(readPositiveInt("NaN", 8080)).toBe(8080);
  });

  it("truncates at the first non-digit, the way parseInt does", () => {
    expect(readPositiveInt("3000abc", 8080)).toBe(3000);
    expect(readPositiveInt("8080.9", 1)).toBe(8080);
  });
});
