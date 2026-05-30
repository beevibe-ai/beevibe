import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  getSecretsKey,
  __resetSecretsKeyForTests,
} from "./secrets.js";

const KEY_A = randomBytes(32).toString("hex");
const KEY_B = randomBytes(32).toString("hex");

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.BEEVIBE_SECRETS_KEY;
  __resetSecretsKeyForTests();
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.BEEVIBE_SECRETS_KEY;
  else process.env.BEEVIBE_SECRETS_KEY = savedKey;
  __resetSecretsKeyForTests();
});

describe("getSecretsKey", () => {
  it("throws when env var is missing", () => {
    delete process.env.BEEVIBE_SECRETS_KEY;
    expect(() => getSecretsKey()).toThrow(/BEEVIBE_SECRETS_KEY is not set/);
  });

  it("throws on wrong length", () => {
    process.env.BEEVIBE_SECRETS_KEY = "abcd";
    expect(() => getSecretsKey()).toThrow(/must decode to 32 bytes/);
  });

  it("accepts a valid 64-hex key", () => {
    process.env.BEEVIBE_SECRETS_KEY = KEY_A;
    expect(getSecretsKey()).toHaveLength(32);
  });
});

describe("encrypt / decrypt roundtrip", () => {
  it("recovers the plaintext", () => {
    process.env.BEEVIBE_SECRETS_KEY = KEY_A;
    const enc = encryptSecret("sk-test-OPENAI_API_KEY-abc123");
    expect(decryptSecret(enc)).toBe("sk-test-OPENAI_API_KEY-abc123");
  });

  it("produces a fresh IV per encryption (no reuse)", () => {
    process.env.BEEVIBE_SECRETS_KEY = KEY_A;
    const a = encryptSecret("same-plaintext");
    const b = encryptSecret("same-plaintext");
    expect(a.value_iv).not.toBe(b.value_iv);
    expect(a.value_encrypted).not.toBe(b.value_encrypted);
  });

  it("handles UTF-8 with multibyte characters", () => {
    process.env.BEEVIBE_SECRETS_KEY = KEY_A;
    const plaintext = "token-with-日本語-and-emoji-🔐";
    const enc = encryptSecret(plaintext);
    expect(decryptSecret(enc)).toBe(plaintext);
  });

  it("handles empty string", () => {
    process.env.BEEVIBE_SECRETS_KEY = KEY_A;
    const enc = encryptSecret("");
    expect(decryptSecret(enc)).toBe("");
  });
});

describe("decryptSecret tamper detection", () => {
  it("throws when ciphertext is modified", () => {
    process.env.BEEVIBE_SECRETS_KEY = KEY_A;
    const enc = encryptSecret("original-secret");
    const tampered = {
      ...enc,
      value_encrypted: enc.value_encrypted.replace(/.$/, (c) =>
        c === "0" ? "1" : "0",
      ),
    };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws when auth tag is modified", () => {
    process.env.BEEVIBE_SECRETS_KEY = KEY_A;
    const enc = encryptSecret("original-secret");
    const tampered = {
      ...enc,
      value_tag: enc.value_tag.replace(/.$/, (c) => (c === "0" ? "1" : "0")),
    };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws when wrong key is used", () => {
    process.env.BEEVIBE_SECRETS_KEY = KEY_A;
    const enc = encryptSecret("original-secret");
    process.env.BEEVIBE_SECRETS_KEY = KEY_B;
    __resetSecretsKeyForTests();
    expect(() => decryptSecret(enc)).toThrow();
  });

  it("throws on malformed IV length", () => {
    process.env.BEEVIBE_SECRETS_KEY = KEY_A;
    const enc = encryptSecret("x");
    expect(() => decryptSecret({ ...enc, value_iv: "deadbeef" })).toThrow(
      /iv must be 12 bytes/,
    );
  });

  it("throws on malformed tag length", () => {
    process.env.BEEVIBE_SECRETS_KEY = KEY_A;
    const enc = encryptSecret("x");
    expect(() => decryptSecret({ ...enc, value_tag: "deadbeef" })).toThrow(
      /tag must be 16 bytes/,
    );
  });
});
