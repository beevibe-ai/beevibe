import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadConfig() {
  return import("./config");
}

describe("api config", () => {
  it("treats missing NEXT_PUBLIC_BV_API_URL as not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "");
    vi.resetModules();
    const { apiBaseUrl, isApiConfigured } = await loadConfig();
    expect(apiBaseUrl).toBeNull();
    expect(isApiConfigured).toBe(false);
  });

  it("trims whitespace and strips trailing slashes", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "  https://api.example.com///  ");
    vi.resetModules();
    const { apiBaseUrl, isApiConfigured } = await loadConfig();
    expect(apiBaseUrl).toBe("https://api.example.com");
    expect(isApiConfigured).toBe(true);
  });

  it("accepts a clean URL unchanged", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "http://localhost:3002");
    vi.resetModules();
    const { apiBaseUrl, isApiConfigured } = await loadConfig();
    expect(apiBaseUrl).toBe("http://localhost:3002");
    expect(isApiConfigured).toBe(true);
  });

  it("returns null for a whitespace-only value", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "   ");
    vi.resetModules();
    const { apiBaseUrl, isApiConfigured } = await loadConfig();
    expect(apiBaseUrl).toBeNull();
    expect(isApiConfigured).toBe(false);
  });

  it("exposes userKey from NEXT_PUBLIC_BV_USER_KEY when set", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "http://localhost:3002");
    vi.stubEnv("NEXT_PUBLIC_BV_USER_KEY", "bv_u_test123");
    vi.resetModules();
    const { userKey } = await loadConfig();
    expect(userKey).toBe("bv_u_test123");
  });

  it("treats missing NEXT_PUBLIC_BV_USER_KEY as null userKey (no auth header)", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "http://localhost:3002");
    vi.stubEnv("NEXT_PUBLIC_BV_USER_KEY", "");
    vi.resetModules();
    const { userKey } = await loadConfig();
    expect(userKey).toBeNull();
  });
});
