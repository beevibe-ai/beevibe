import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  // happy-dom's localStorage isn't always reliable inside resetModules
  // cycles; stub a minimal in-memory shim so getUserKey/setUserKey/etc.
  // exercise their real code paths.
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true });
});

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

  it("getUserKey() ignores NEXT_PUBLIC_BV_USER_KEY (env fallback was removed)", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "http://localhost:3002");
    vi.stubEnv("NEXT_PUBLIC_BV_USER_KEY", "bv_u_envFallback");
    vi.resetModules();
    const { getUserKey } = await loadConfig();
    // Pre-password-auth, the env var was honored as a dev convenience.
    // It auto-signed-in every visitor and auto-re-signed-in after
    // sign-out (because clearUserKey just dropped to the env value).
    // Now: env is ignored, sign-out actually signs you out.
    expect(getUserKey()).toBeNull();
  });

  it("getUserKey() returns null when nothing's stored", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "http://localhost:3002");
    vi.resetModules();
    const { getUserKey } = await loadConfig();
    expect(getUserKey()).toBeNull();
  });

  it("setUserKey persists to localStorage and getUserKey reads it back; clear unwinds", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "http://localhost:3002");
    vi.resetModules();
    const { getUserKey, setUserKey, clearUserKey } = await loadConfig();
    setUserKey("bv_u_runtime");
    expect(getUserKey()).toBe("bv_u_runtime");
    clearUserKey();
    expect(getUserKey()).toBeNull();
  });

  it("isWellFormedUserKey rejects garbage and accepts proper bv_u_ keys", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "http://localhost:3002");
    vi.resetModules();
    const { isWellFormedUserKey } = await loadConfig();
    expect(isWellFormedUserKey("bv_u_abcdefghijklmnop")).toBe(true);
    expect(isWellFormedUserKey("bv_u_short")).toBe(false);
    expect(isWellFormedUserKey("not_a_key")).toBe(false);
    expect(isWellFormedUserKey("bv_a_agentKey1234567890")).toBe(false);
  });
});
