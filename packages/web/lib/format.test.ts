import { describe, expect, it } from "vitest";
import {
  formatIntent,
  formatRelativeTime,
  formatReviewPolicy,
  idSuffix,
  sessionHref,
  shortId,
} from "./format";

// `deriveShortId`, `formatDurationLabel` and `truncate` are re-exported
// straight from @beevibe/core/domain/format and covered there — only the
// logic that lives in this module is exercised here.

describe("formatRelativeTime", () => {
  const now = new Date("2026-03-01T12:00:00Z");

  it("adds the ' ago' suffix to each rung of the ladder", () => {
    expect(formatRelativeTime("2026-03-01T11:58:00Z", now)).toBe("2m ago");
    expect(formatRelativeTime("2026-03-01T09:00:00Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2026-02-26T12:00:00Z", now)).toBe("3d ago");
    expect(formatRelativeTime("2025-12-01T12:00:00Z", now)).toBe("3mo ago");
    expect(formatRelativeTime("2024-03-01T12:00:00Z", now)).toBe("2y ago");
  });

  it("leaves 'just now' unsuffixed and renders a bad date as a dash", () => {
    expect(formatRelativeTime("2026-03-01T11:59:30Z", now)).toBe("just now");
    expect(formatRelativeTime("not-a-date", now)).toBe("—");
  });
});

describe("shortId", () => {
  it("prefixes the 6-char derived id with #", () => {
    expect(shortId("sess_kBpTkqiCbsB3")).toBe("#kBpTkq");
  });
});

describe("formatIntent", () => {
  it("labels a self-closing task wrapper as a lifecycle reminder", () => {
    expect(formatIntent('<task id="task_abc123"/>')).toBe("Lifecycle reminder");
    // Surrounding whitespace is tolerated by the anchored pattern.
    expect(formatIntent('  <task id="task_abc123"/>  ')).toBe("Lifecycle reminder");
  });

  it("returns only the first block of a wrapped task intent", () => {
    expect(
      formatIntent('<task id="task_abc123">Ship the thing\n\nLong description here.</task>'),
    ).toBe("Ship the thing");
  });

  it("returns the whole inner body when there is no blank-line split", () => {
    expect(formatIntent('<task id="task_abc123">Just a title</task>')).toBe("Just a title");
  });

  it("handles a multi-line title and an empty wrapper", () => {
    // Single newlines stay inside the first block; only \n\n splits.
    expect(formatIntent('<task id="t_1">line one\nline two\n\nbody</task>')).toBe(
      "line one\nline two",
    );
    expect(formatIntent('<task id="t_1"></task>')).toBe("");
  });

  it("passes a plain chat intent through unchanged", () => {
    expect(formatIntent("what does this repo do?")).toBe("what does this repo do?");
    // A wrapper that isn't the whole string is not a wrapper.
    expect(formatIntent('prefix <task id="t_1">title</task>')).toBe(
      'prefix <task id="t_1">title</task>',
    );
  });
});

describe("idSuffix", () => {
  it("strips the typed-id prefix", () => {
    expect(idSuffix("agent_kBpTkqiCbsB3")).toBe("kBpTkqiCbsB3");
  });

  it("falls back to the full id when there is no usable suffix", () => {
    expect(idSuffix("nounderscore")).toBe("nounderscore");
    // Trailing underscore leaves an empty suffix → fall back to the input.
    expect(idSuffix("agent_")).toBe("agent_");
  });

  it("splits on the first underscore only", () => {
    expect(idSuffix("a_b_c")).toBe("b_c");
  });
});

describe("sessionHref", () => {
  it("nests under the task when a task id is given", () => {
    expect(sessionHref("sess_kBpTkqiCbsB3", "task_xyz789")).toBe(
      "/tasks/task_xyz789/sessions/kBpTkq",
    );
  });

  it("uses the flat session route otherwise", () => {
    expect(sessionHref("sess_kBpTkqiCbsB3")).toBe("/sessions/kBpTkq");
  });
});

describe("formatReviewPolicy", () => {
  it("renders the require_human sentinel in prose", () => {
    expect(formatReviewPolicy("require_human")).toBe("require human");
  });

  it("treats everything else — including legacy null — as auto-done", () => {
    expect(formatReviewPolicy("auto_done")).toBe("auto-done");
    expect(formatReviewPolicy(null)).toBe("auto-done");
    expect(formatReviewPolicy(undefined)).toBe("auto-done");
  });
});
