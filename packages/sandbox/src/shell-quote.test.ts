/**
 * Unit tests for `shellQuote` — the escaping every path, filename and URL
 * passes through on its way into a `sh -c` command line inside a container.
 * Pure string work, so unlike `docker.e2e.test.ts` these need no Docker.
 */
import { describe, expect, it } from "vitest";
import { shellQuote } from "./docker.js";

describe("shellQuote", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shellQuote("/sandbox/out.txt")).toBe("'/sandbox/out.txt'");
  });

  it("neutralizes spaces so a path stays one argument", () => {
    expect(shellQuote("my file.txt")).toBe("'my file.txt'");
  });

  it("closes and reopens around an embedded single quote", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("keeps a command-substitution attempt inert", () => {
    // Inside single quotes the shell expands nothing, so `$(...)` stays
    // literal rather than running.
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });

  it("keeps a quote-break-out attempt inert", () => {
    // The `'` that would close our quoting is itself escaped, so the
    // trailing `; rm -rf /` cannot become a second command.
    const quoted = shellQuote(`'; rm -rf /; echo '`);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    expect(quoted).toBe(`''\\''; rm -rf /; echo '\\'''`);
  });

  it("leaves other shell metacharacters literal", () => {
    expect(shellQuote("a;b|c&d>e")).toBe("'a;b|c&d>e'");
  });

  it("handles the empty string", () => {
    expect(shellQuote("")).toBe("''");
  });
});
