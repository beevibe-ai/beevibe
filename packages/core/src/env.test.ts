/**
 * Composition-root env helpers. Both functions are pure over a snapshot,
 * so the interesting cases are the malformed inputs a real deploy
 * produces: an env var set to the empty string, a non-numeric port, a
 * PaaS that only exposes its public domain.
 */

import { describe, expect, it } from "vitest";
import { readPositiveInt, resolveMcpServerUrl } from "./env.js";

describe("resolveMcpServerUrl", () => {
  it("prefers an explicit BEEVIBE_MCP_SERVER_URL", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "https://mcp.example.com/mcp",
        RAILWAY_PUBLIC_DOMAIN: "ignored.up.railway.app",
      }),
    ).toBe("https://mcp.example.com/mcp");
  });

  it("derives the Railway URL when only the public domain is set", () => {
    expect(resolveMcpServerUrl({ RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app" })).toBe(
      "https://app.up.railway.app/mcp",
    );
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveMcpServerUrl({})).toBeUndefined();
  });

  it("falls through an empty explicit URL to the Railway fallback", () => {
    // An env var set to "" is the classic PaaS footgun — treat it as unset
    // rather than handing agents an empty MCP endpoint.
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "",
        RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
      }),
    ).toBe("https://app.up.railway.app/mcp");
  });

  it("returns undefined when both vars are empty strings", () => {
    expect(
      resolveMcpServerUrl({ BEEVIBE_MCP_SERVER_URL: "", RAILWAY_PUBLIC_DOMAIN: "" }),
    ).toBeUndefined();
  });

  it("reads only the snapshot it is handed, not process.env", () => {
    expect(resolveMcpServerUrl({ UNRELATED: "x" })).toBeUndefined();
  });
});

describe("readPositiveInt", () => {
  it("parses a plain integer", () => {
    expect(readPositiveInt("8080", 3000)).toBe(8080);
  });

  it("falls back when the var is undefined", () => {
    expect(readPositiveInt(undefined, 3000)).toBe(3000);
  });

  it("falls back on the empty string — Number('') would yield port 0", () => {
    expect(readPositiveInt("", 3000)).toBe(3000);
  });

  it("falls back on non-numeric input", () => {
    expect(readPositiveInt("not-a-port", 3000)).toBe(3000);
    expect(readPositiveInt("NaN", 3000)).toBe(3000);
  });

  it("falls back on zero and on negatives", () => {
    expect(readPositiveInt("0", 3000)).toBe(3000);
    expect(readPositiveInt("-1", 3000)).toBe(3000);
  });

  it("truncates a decimal to its integer part", () => {
    expect(readPositiveInt("8080.9", 3000)).toBe(8080);
  });

  it("tolerates surrounding whitespace", () => {
    expect(readPositiveInt("  8080  ", 3000)).toBe(8080);
  });

  it("takes the leading digits of a mixed string, as parseInt does", () => {
    expect(readPositiveInt("8080abc", 3000)).toBe(8080);
  });

  it("falls back when the digits do not come first", () => {
    expect(readPositiveInt("abc8080", 3000)).toBe(3000);
  });

  it("parses in base 10 — a leading zero is not octal", () => {
    expect(readPositiveInt("010", 3000)).toBe(10);
  });

  it("returns the fallback unchanged even when the fallback is itself odd", () => {
    expect(readPositiveInt(undefined, 0)).toBe(0);
  });
});
