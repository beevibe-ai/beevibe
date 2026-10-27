import { describe, expect, it } from "vitest";

import { EMAIL_RE, isValidEmail } from "./constants.js";

describe("isValidEmail", () => {
  it("accepts ordinary addresses", () => {
    for (const ok of [
      "a@b.co",
      "user@example.com",
      "first.last+tag@sub.domain.org",
      "UPPER@EXAMPLE.COM",
    ]) {
      expect(isValidEmail(ok)).toBe(true);
    }
  });

  it("rejects the shapes the sign-up form has to catch", () => {
    for (const bad of [
      "",
      "plainstring",
      "no-domain@",
      "@no-local.com",
      "no-dot@domain",
      "two@at@signs.com",
      "spaces in@domain.com",
      "trailing@space.com ",
    ]) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });

  it("rejects the empty string, which is why callers need no separate falsy guard", () => {
    // /signin and /signup both used to write `!email || !EMAIL_RE.test(email)`;
    // the first half was dead because the pattern requires a local part.
    expect(isValidEmail("")).toBe(false);
  });

  it("is anchored, so an address embedded in a longer string is rejected", () => {
    expect(isValidEmail("name <user@example.com>")).toBe(false);
    expect(EMAIL_RE.test("user@example.com\nevil@example.com")).toBe(false);
  });
});
