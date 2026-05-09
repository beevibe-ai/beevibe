import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeMockStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    clear() {
      store = {};
    },
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null;
    },
    removeItem(key: string) {
      delete store[key];
    },
    setItem(key: string, value: string) {
      store[key] = value;
    },
  };
}

beforeEach(() => {
  // happy-dom in this project ships an unconfigured `localStorage` (no
  // setItem / getItem). Inject a minimal in-memory mock for these tests.
  Object.defineProperty(window, "localStorage", {
    value: makeMockStorage(),
    configurable: true,
    writable: true,
  });
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

  it("getUserKey() returns NEXT_PUBLIC_BV_USER_KEY when no localStorage entry", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "http://localhost:3002");
    vi.stubEnv("NEXT_PUBLIC_BV_USER_KEY", "bv_u_envfallback");
    vi.resetModules();
    const { getUserKey } = await loadConfig();
    expect(getUserKey()).toBe("bv_u_envfallback");
  });

  it("getUserKey() returns null when neither env nor localStorage has a key", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "http://localhost:3002");
    vi.stubEnv("NEXT_PUBLIC_BV_USER_KEY", "");
    vi.resetModules();
    const { getUserKey } = await loadConfig();
    expect(getUserKey()).toBeNull();
  });

  it("setUserKey() persists to localStorage and getUserKey() returns it (overriding env)", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "http://localhost:3002");
    vi.stubEnv("NEXT_PUBLIC_BV_USER_KEY", "bv_u_env");
    vi.resetModules();
    const { getUserKey, setUserKey } = await loadConfig();
    setUserKey("bv_u_localstorage");
    expect(getUserKey()).toBe("bv_u_localstorage");
  });

  it("clearUserKey() removes localStorage entry, falling back to env", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "http://localhost:3002");
    vi.stubEnv("NEXT_PUBLIC_BV_USER_KEY", "bv_u_env");
    vi.resetModules();
    const { getUserKey, setUserKey, clearUserKey } = await loadConfig();
    setUserKey("bv_u_localstorage");
    clearUserKey();
    expect(getUserKey()).toBe("bv_u_env");
  });

  it("subscribeToUserKey() fires on setUserKey + clearUserKey, stops after unsubscribe", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "http://localhost:3002");
    vi.resetModules();
    const { setUserKey, clearUserKey, subscribeToUserKey } = await loadConfig();
    const cb = vi.fn();
    const unsub = subscribeToUserKey(cb);
    setUserKey("bv_u_one");
    setUserKey("bv_u_two");
    clearUserKey();
    expect(cb).toHaveBeenCalledTimes(3);
    unsub();
    setUserKey("bv_u_three");
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("isWellFormedUserKey accepts well-formed bv_u_ keys and rejects others", async () => {
    vi.stubEnv("NEXT_PUBLIC_BV_API_URL", "http://localhost:3002");
    vi.resetModules();
    const { isWellFormedUserKey } = await loadConfig();
    expect(isWellFormedUserKey("bv_u_abc1234567890ABCD")).toBe(true);
    expect(isWellFormedUserKey("bv_u_short")).toBe(false);
    expect(isWellFormedUserKey("bv_a_abc1234567890ABCD")).toBe(false);
    expect(isWellFormedUserKey("nope")).toBe(false);
    expect(isWellFormedUserKey("")).toBe(false);
  });
});
