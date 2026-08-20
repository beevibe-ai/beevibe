import { describe, expect, it } from "vitest";
import { readPositiveInt, resolveMcpServerUrl } from "./env.js";

describe("resolveMcpServerUrl", () => {
  it("prefers BEEVIBE_MCP_SERVER_URL over the Railway fallback", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "https://mcp.explicit.example/mcp",
        RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
      }),
    ).toBe("https://mcp.explicit.example/mcp");
  });

  it("returns the explicit URL even if Railway is unset", () => {
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "https://mcp.explicit.example/mcp",
      }),
    ).toBe("https://mcp.explicit.example/mcp");
  });

  it("synthesizes an https://<domain>/mcp URL from RAILWAY_PUBLIC_DOMAIN", () => {
    expect(
      resolveMcpServerUrl({ RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app" }),
    ).toBe("https://app.up.railway.app/mcp");
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveMcpServerUrl({})).toBeUndefined();
  });

  it("treats explicit empty string as unset and falls through", () => {
    // Same shape a live process.env has for a var that was `export X=`
    expect(
      resolveMcpServerUrl({
        BEEVIBE_MCP_SERVER_URL: "",
        RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
      }),
    ).toBe("https://app.up.railway.app/mcp");
  });
});

describe("readPositiveInt", () => {
  it("returns the fallback when the raw value is undefined", () => {
    expect(readPositiveInt(undefined, 3000)).toBe(3000);
  });

  it("returns the fallback when the raw value is the empty string", () => {
    // Guards against Number("") === 0 silently binding a random port.
    expect(readPositiveInt("", 3000)).toBe(3000);
  });

  it("parses an integer-looking value", () => {
    expect(readPositiveInt("4242", 3000)).toBe(4242);
  });

  it("truncates on parseInt semantics — decimals lose their fractional part", () => {
    expect(readPositiveInt("42.9", 3000)).toBe(42);
  });

  it("returns the fallback on a non-numeric string", () => {
    expect(readPositiveInt("abc", 3000)).toBe(3000);
  });

  it("returns the fallback on zero (must be strictly positive)", () => {
    expect(readPositiveInt("0", 3000)).toBe(3000);
  });

  it("returns the fallback on a negative integer", () => {
    expect(readPositiveInt("-1", 3000)).toBe(3000);
  });

  it("returns the fallback when the fallback is negative too — parseInt result must still be > 0", () => {
    // Documents that the > 0 guard is on the parsed value, not the fallback.
    expect(readPositiveInt("bad", -5)).toBe(-5);
    expect(readPositiveInt("7", -5)).toBe(7);
  });
});
