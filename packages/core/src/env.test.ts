import { describe, expect, it } from "vitest";

import { readPositiveInt, resolveMcpServerUrl } from "./env.js";

describe("resolveMcpServerUrl", () => {
  it("prefers the explicit operator setting", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "https://beevibe.internal/mcp",
        RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app",
      }),
    ).toBe("https://beevibe.internal/mcp");
  });

  it("derives the Railway URL when only the PaaS domain is set", () => {
    expect(resolveMcpServerUrl({ RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app" })).toBe(
      "https://beevibe.up.railway.app/mcp",
    );
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveMcpServerUrl({})).toBeUndefined();
  });

  // An empty string is what a declared-but-unset var looks like in a
  // docker-compose / Railway env. Treating it as "set" would hand the
  // CLIs an empty MCP URL instead of falling through.
  it("falls through an empty explicit setting to the Railway domain", () => {
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
  it("parses a plain integer", () => {
    expect(readPositiveInt("3001", 3000)).toBe(3001);
  });

  it("falls back on undefined", () => {
    expect(readPositiveInt(undefined, 3000)).toBe(3000);
  });

  // The guard this function exists for: Number("") is 0, which would
  // bind an HTTP server to a random port instead of the default.
  it("falls back on the empty string rather than yielding 0", () => {
    expect(readPositiveInt("", 3000)).toBe(3000);
  });

  it("falls back on non-numeric text", () => {
    expect(readPositiveInt("not-a-port", 3000)).toBe(3000);
  });

  it("falls back on zero and on negatives", () => {
    expect(readPositiveInt("0", 3000)).toBe(3000);
    expect(readPositiveInt("-1", 3000)).toBe(3000);
  });

  it("truncates a decimal to its integer part", () => {
    expect(readPositiveInt("3001.9", 3000)).toBe(3001);
  });

  it("takes the leading integer of a trailing-garbage value", () => {
    expect(readPositiveInt("3001abc", 3000)).toBe(3001);
  });
});
