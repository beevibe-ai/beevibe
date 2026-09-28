/**
 * Composition-root env helpers. Both are read by binaries with no tests
 * of their own (`api/src/main.ts`, `scheduler/src/main.ts`,
 * `process-lifecycle.ts`), so this is the only place their edges are
 * pinned — and the edges are what matter: `Number("")` is 0, which would
 * bind an HTTP server to a random port, and a missing MCP URL fallback
 * breaks one-click Railway deploys.
 */
import { describe, expect, it } from "vitest";
import { readPositiveInt, resolveMcpServerUrl } from "./env.js";

describe("resolveMcpServerUrl", () => {
  it("prefers an explicit BEEVIBE_MCP_SERVER_URL", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "https://beevibe.test/mcp",
        RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
      }),
    ).toBe("https://beevibe.test/mcp");
  });

  it("derives the Railway fallback so a one-click deploy needs no config", () => {
    expect(
      resolveMcpServerUrl({ RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app" }),
    ).toBe("https://app.up.railway.app/mcp");
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveMcpServerUrl({})).toBeUndefined();
  });

  it("treats an empty explicit URL as unset and falls through", () => {
    // Railway-style platforms inject empty strings for unset vars; an
    // empty MCP URL must not win over the derivable fallback.
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "",
        RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
      }),
    ).toBe("https://app.up.railway.app/mcp");
    expect(
      resolveMcpServerUrl({ BEEVIBE_MCP_SERVER_URL: "", RAILWAY_PUBLIC_DOMAIN: "" }),
    ).toBeUndefined();
  });
});

describe("readPositiveInt", () => {
  it("parses a positive integer", () => {
    expect(readPositiveInt("8080", 3000)).toBe(8080);
  });

  it("falls back on undefined and on the empty string", () => {
    // The empty-string case is the whole reason this helper exists:
    // Number("") is 0, which asks Node to pick a random port.
    expect(readPositiveInt(undefined, 3000)).toBe(3000);
    expect(readPositiveInt("", 3000)).toBe(3000);
  });

  it.each(["0", "-1", "abc", "NaN", "Infinity", " ", "+"])(
    "falls back on %j",
    (raw) => {
      expect(readPositiveInt(raw, 3000)).toBe(3000);
    },
  );

  it("takes the leading integer of a trailing-garbage value, as parseInt does", () => {
    // Documented rather than desired: "8080abc" and "8080.9" both come
    // from a fat-fingered env var, and 8080 is the useful reading.
    expect(readPositiveInt("8080abc", 3000)).toBe(8080);
    expect(readPositiveInt("8080.9", 3000)).toBe(8080);
    // Exponent notation is the sharp edge of that rule: base-10 parseInt
    // stops at the `e`, so `PORT=1e3` binds port 1, not 1000. Pinned so a
    // future switch to Number()/coercion shows up as a test change.
    expect(readPositiveInt("1e3", 3000)).toBe(1);
  });

  it("tolerates surrounding whitespace", () => {
    expect(readPositiveInt("  8080  ", 3000)).toBe(8080);
  });

  it("returns the fallback verbatim, including a zero sentinel", () => {
    // scheduler/main.ts passes 0 as "unset" and then `|| undefined`s it.
    expect(readPositiveInt(undefined, 0)).toBe(0);
  });
});
