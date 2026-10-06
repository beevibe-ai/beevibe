/**
 * Web-side display helpers.
 *
 * `shortId` / `sessionHref` are link-shaped: they decide the URL
 * fragment the web navigates to, and the api derives the `short_id` it
 * serializes from the same `deriveShortId`. A change on one side alone
 * produces links that 404, so the shapes are pinned here. `formatIntent`
 * is the only place the `<task>` intent wrapper is unwrapped for
 * display — without it the chat and session surfaces render raw XML.
 */
import { describe, expect, it } from "vitest";
import {
  formatIntent,
  formatRelativeTime,
  formatReviewPolicy,
  idSuffix,
  sessionHref,
  shortId,
} from "./format";

describe("shortId", () => {
  it("strips the typed-id prefix and prefixes a hash", () => {
    expect(shortId("task_AbCdEfGhIjKl")).toBe("#AbCdEf");
  });

  it("passes through an id with no prefix", () => {
    expect(shortId("AbCdEfGhIjKl")).toBe("#AbCdEf");
  });
});

describe("idSuffix", () => {
  it("returns everything after the first underscore", () => {
    expect(idSuffix("agent_kBpTkqiCbsB3")).toBe("kBpTkqiCbsB3");
  });

  it("keeps later underscores in the suffix", () => {
    expect(idSuffix("agent_a_b")).toBe("a_b");
  });

  it("falls back to the whole string when there is no underscore", () => {
    expect(idSuffix("nounderscore")).toBe("nounderscore");
  });

  it("falls back to the whole string when the suffix would be empty", () => {
    expect(idSuffix("agent_")).toBe("agent_");
  });
});

describe("sessionHref", () => {
  it("links to the standalone session route by short id", () => {
    expect(sessionHref("sess_AbCdEfGhIjKl")).toBe("/sessions/AbCdEf");
  });

  it("nests the session under its task when one is given", () => {
    expect(sessionHref("sess_AbCdEfGhIjKl", "task_ZzYyXx")).toBe(
      "/tasks/task_ZzYyXx/sessions/AbCdEf",
    );
  });
});

describe("formatIntent", () => {
  it("labels a self-closing task intent as a lifecycle reminder", () => {
    expect(formatIntent('<task id="task_abc"/>')).toBe("Lifecycle reminder");
  });

  it("tolerates surrounding whitespace on the self-closing form", () => {
    expect(formatIntent('  <task id="task_abc"/>  ')).toBe("Lifecycle reminder");
  });

  it("unwraps a wrapped task intent down to its title", () => {
    expect(formatIntent('<task id="task_abc">Fix the login bug</task>')).toBe(
      "Fix the login bug",
    );
  });

  it("keeps only the first block when a description follows the title", () => {
    const intent =
      '<task id="task_abc">Fix the login bug\n\nThe session cookie expires early.</task>';
    expect(formatIntent(intent)).toBe("Fix the login bug");
  });

  it("returns an empty string for an empty wrapper rather than raw XML", () => {
    expect(formatIntent('<task id="task_abc"></task>')).toBe("");
  });

  it("passes a plain chat intent through unchanged", () => {
    expect(formatIntent("What did we decide about auth?")).toBe(
      "What did we decide about auth?",
    );
  });

  it("passes through a partial wrapper it cannot parse", () => {
    const intent = '<task id="task_abc">no closing tag';
    expect(formatIntent(intent)).toBe(intent);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-01-15T12:00:00.000Z");

  it.each([
    ["just now", "2026-01-15T11:59:58.000Z"],
    ["2m ago", "2026-01-15T11:58:00.000Z"],
    ["3h ago", "2026-01-15T09:00:00.000Z"],
    ["2d ago", "2026-01-13T12:00:00.000Z"],
  ])("renders %s", (expected, iso) => {
    expect(formatRelativeTime(iso, now)).toBe(expected);
  });
});

describe("formatReviewPolicy", () => {
  it("renders the require_human sentinel in prose", () => {
    expect(formatReviewPolicy("require_human")).toBe("require human");
  });

  it.each([
    ["auto_done", "auto_done"],
    ["null (pre-#102 agents)", null],
    ["undefined", undefined],
    ["an unknown value", "something_else"],
  ])("renders %s as auto-done", (_label, policy) => {
    expect(formatReviewPolicy(policy)).toBe("auto-done");
  });
});
