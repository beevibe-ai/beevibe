import { afterEach, describe, expect, it } from "vitest";
import { requireApiKey } from "./provider-common.js";

const ENV = "BEEVIBE_TEST_PROVIDER_KEY";

describe("requireApiKey", () => {
  afterEach(() => {
    delete process.env[ENV];
  });

  it("prefers an explicit override over the environment", () => {
    process.env[ENV] = "from-env";
    expect(requireApiKey("FakeAdapter", ENV, "from-config")).toBe("from-config");
  });

  it("falls back to the environment variable", () => {
    process.env[ENV] = "from-env";
    expect(requireApiKey("FakeAdapter", ENV, undefined)).toBe("from-env");
  });

  it("throws naming the adapter, the variable, and both ways to supply it", () => {
    expect(() => requireApiKey("FakeAdapter", ENV, undefined)).toThrow(
      `FakeAdapter: ${ENV} missing (pass apiKey or set env var)`,
    );
  });

  // An empty string is a misconfigured env var, not a credential — treating
  // it as present would defer the failure to a 401 on the first request.
  it("treats an empty env var as missing", () => {
    process.env[ENV] = "";
    expect(() => requireApiKey("FakeAdapter", ENV, undefined)).toThrow("missing");
  });

  // `??` not `||`: an empty-string override short-circuits, so it does NOT
  // fall back to the env var — it throws. That is what all three adapters
  // did before this helper existed, so it is pinned rather than "fixed":
  // passing `apiKey: ""` explicitly is a caller bug, and silently reading a
  // different credential than the one asked for would hide it.
  it("throws on an empty override rather than falling back to the env", () => {
    process.env[ENV] = "from-env";
    expect(() => requireApiKey("FakeAdapter", ENV, "")).toThrow("missing");
  });
});
