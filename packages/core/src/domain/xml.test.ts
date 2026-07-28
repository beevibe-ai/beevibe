import { describe, expect, it } from "vitest";
import { escapeXmlAttr, escapeXmlText } from "./xml.js";

describe("escapeXmlAttr", () => {
  it("escapes the ampersand exactly once", () => {
    // The regression this guards: escaping `"` before `&` re-escapes the
    // ampersand that `&quot;` just introduced, yielding `&amp;quot;`.
    expect(escapeXmlAttr('say "hi"')).toBe("say &quot;hi&quot;");
  });

  it("escapes a bare ampersand", () => {
    expect(escapeXmlAttr("R&D")).toBe("R&amp;D");
  });

  it("escapes ampersands and quotes together without double-escaping", () => {
    expect(escapeXmlAttr('R&D "x"')).toBe("R&amp;D &quot;x&quot;");
  });

  it("escapes angle brackets so a value cannot open a tag", () => {
    expect(escapeXmlAttr("<block>")).toBe("&lt;block&gt;");
  });

  it("leaves plain text untouched", () => {
    expect(escapeXmlAttr("agent_01ABC")).toBe("agent_01ABC");
  });

  it("is stable on the empty string", () => {
    expect(escapeXmlAttr("")).toBe("");
  });
});

describe("escapeXmlText", () => {
  it("escapes ampersand and angle brackets", () => {
    expect(escapeXmlText("a & b <c>")).toBe("a &amp; b &lt;c&gt;");
  });

  it("leaves quotes alone — they are legal in element text", () => {
    expect(escapeXmlText('say "hi"')).toBe('say "hi"');
  });

  it("does not double-escape an ampersand", () => {
    expect(escapeXmlText("&lt;")).toBe("&amp;lt;");
  });
});
