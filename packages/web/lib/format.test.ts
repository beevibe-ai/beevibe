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
  it("strips the typed-id prefix and prepends '#', keeping six chars", () => {
    expect(shortId("sess_abc123def456")).toBe("#abc123");
    expect(shortId("agent_kBpTkqiCbsB3")).toBe("#kBpTkq");
  });

  it("handles ids shorter than the six-char window", () => {
    expect(shortId("task_ab")).toBe("#ab");
  });
});

describe("idSuffix", () => {
  it("returns everything after the first underscore", () => {
    expect(idSuffix("agent_kBpTkqiCbsB3")).toBe("kBpTkqiCbsB3");
    expect(idSuffix("sess_abc123")).toBe("abc123");
  });

  it("returns the whole string when there is no underscore", () => {
    expect(idSuffix("kBpTkqiCbsB3")).toBe("kBpTkqiCbsB3");
  });

  it("falls back to the full id when the suffix would be empty", () => {
    // `agent_` has an underscore but nothing after it → slice() is "" →
    // guard returns the original.
    expect(idSuffix("agent_")).toBe("agent_");
  });

  it("keeps only the first split point when multiple underscores exist", () => {
    expect(idSuffix("mcp__beevibe__ask")).toBe("_beevibe__ask");
  });
});

describe("sessionHref", () => {
  it("builds a plain session href from the derived short id", () => {
    expect(sessionHref("sess_abc123def456")).toBe("/sessions/abc123");
  });

  it("nests under the task when a taskId is supplied", () => {
    expect(sessionHref("sess_abc123def456", "task_xyz")).toBe(
      "/tasks/task_xyz/sessions/abc123",
    );
  });

  it("treats an empty taskId as absent", () => {
    expect(sessionHref("sess_abc123def456", "")).toBe("/sessions/abc123");
  });
});

describe("formatReviewPolicy", () => {
  it("renders the require_human sentinel as 'require human'", () => {
    expect(formatReviewPolicy("require_human")).toBe("require human");
  });

  it("renders every other value — including legacy null/undefined — as 'auto-done'", () => {
    expect(formatReviewPolicy("auto_done")).toBe("auto-done");
    expect(formatReviewPolicy(null)).toBe("auto-done");
    expect(formatReviewPolicy(undefined)).toBe("auto-done");
    expect(formatReviewPolicy("anything-else")).toBe("auto-done");
  });
});

describe("formatIntent", () => {
  it("labels a self-closing task tag as a lifecycle reminder", () => {
    expect(formatIntent('<task id="task_abc"/>')).toBe("Lifecycle reminder");
    // Surrounding whitespace is tolerated.
    expect(formatIntent('  <task id="task_abc"/>  ')).toBe("Lifecycle reminder");
  });

  it("unwraps a task tag to its first title block", () => {
    const intent = '<task id="task_abc">Ship the login page\n\nDetailed body here</task>';
    expect(formatIntent(intent)).toBe("Ship the login page");
  });

  it("returns the whole inner text when there is no blank-line split", () => {
    expect(formatIntent('<task id="task_abc">Just a title</task>')).toBe("Just a title");
  });

  it("trims whitespace around the extracted title", () => {
    const intent = '<task id="task_abc">   Padded title   \n\nbody</task>';
    expect(formatIntent(intent)).toBe("Padded title");
  });

  it("passes chat intents (no wrapper) through unchanged", () => {
    expect(formatIntent("just a normal chat message")).toBe("just a normal chat message");
  });

  it("leaves malformed / mismatched tags untouched", () => {
    // No closing tag → neither pattern matches → verbatim passthrough.
    expect(formatIntent('<task id="task_abc">unterminated')).toBe(
      '<task id="task_abc">unterminated',
    );
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");

  it("reports very recent times as 'just now'", () => {
    expect(formatRelativeTime(new Date("2026-08-18T11:59:59.000Z"), now)).toBe("just now");
  });

  it("appends the ' ago' suffix for elapsed minutes / hours / days", () => {
    expect(formatRelativeTime(new Date("2026-08-18T11:58:00.000Z"), now)).toBe("2m ago");
    expect(formatRelativeTime(new Date("2026-08-18T09:00:00.000Z"), now)).toBe("3h ago");
    expect(formatRelativeTime(new Date("2026-08-15T12:00:00.000Z"), now)).toBe("3d ago");
  });

  it("accepts an ISO string as the input date", () => {
    expect(formatRelativeTime("2026-08-18T11:58:00.000Z", now)).toBe("2m ago");
  });
});
