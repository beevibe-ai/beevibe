import { describe, expect, it } from "vitest";
import {
  formatIntent,
  formatRelativeTime,
  formatReviewPolicy,
  idSuffix,
  sessionHref,
  shortId,
} from "./format";

describe("formatRelativeTime", () => {
  const now = new Date("2026-01-10T12:00:00Z");

  it("labels the present as 'just now'", () => {
    expect(formatRelativeTime(now, now)).toBe("just now");
  });

  it("appends ' ago' to the relative ladder", () => {
    expect(formatRelativeTime(new Date("2026-01-10T11:58:00Z"), now)).toBe("2m ago");
    expect(formatRelativeTime(new Date("2026-01-10T09:00:00Z"), now)).toBe("3h ago");
    expect(formatRelativeTime(new Date("2026-01-07T12:00:00Z"), now)).toBe("3d ago");
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(formatRelativeTime("2026-01-10T11:58:00Z", now)).toBe("2m ago");
  });

  it("defaults the reference point to the current clock", () => {
    expect(formatRelativeTime(new Date(Date.now() - 120_000))).toBe("2m ago");
  });
});

describe("shortId", () => {
  it("strips the typed prefix, takes 6 chars and prepends '#'", () => {
    expect(shortId("agent_kBpTkqiCbsB3")).toBe("#kBpTkq");
    expect(shortId("sess_ABCDEF1234")).toBe("#ABCDEF");
  });

  it("passes an unprefixed id through, still capped at 6", () => {
    expect(shortId("abcdefgh")).toBe("#abcdef");
  });
});

describe("idSuffix", () => {
  it("returns everything after the first underscore", () => {
    expect(idSuffix("agent_kBpTkqiCbsB3")).toBe("kBpTkqiCbsB3");
  });

  it("keeps later underscores in the suffix", () => {
    expect(idSuffix("agent_a_b")).toBe("a_b");
  });

  it("falls back to the whole id when there is no underscore", () => {
    expect(idSuffix("kBpTkqiCbsB3")).toBe("kBpTkqiCbsB3");
  });

  it("falls back to the whole id when the suffix would be empty", () => {
    expect(idSuffix("agent_")).toBe("agent_");
  });
});

describe("sessionHref", () => {
  it("links to the standalone session route when there is no task", () => {
    expect(sessionHref("sess_ABCDEF1234")).toBe("/sessions/ABCDEF");
  });

  it("nests under the task route when a task id is given", () => {
    expect(sessionHref("sess_ABCDEF1234", "task_XYZ")).toBe(
      "/tasks/task_XYZ/sessions/ABCDEF",
    );
  });

  it("uses the full task id, not its short form, in the task segment", () => {
    // The route resolves tasks by either form; the link keeps the full id.
    expect(sessionHref("sess_ABCDEF1234", "task_1234567890")).toContain(
      "/tasks/task_1234567890/",
    );
  });
});

describe("formatIntent", () => {
  it("labels a self-closing task wrapper as a lifecycle reminder", () => {
    expect(formatIntent('<task id="task_1"/>')).toBe("Lifecycle reminder");
    expect(formatIntent('  <task id="task_1"/>  ')).toBe("Lifecycle reminder");
  });

  it("returns the first block of a wrapped intent — the title", () => {
    expect(formatIntent('<task id="task_1">Ship the thing\n\nLong description here</task>')).toBe(
      "Ship the thing",
    );
  });

  it("trims surrounding whitespace inside the wrapper", () => {
    expect(formatIntent('<task id="task_1">\n  Ship the thing  \n\nBody\n</task>')).toBe(
      "Ship the thing",
    );
  });

  it("handles a wrapped intent with no blank-line split", () => {
    expect(formatIntent('<task id="task_1">Just a title</task>')).toBe("Just a title");
  });

  it("handles a wrapped intent whose body is empty", () => {
    expect(formatIntent('<task id="task_1"></task>')).toBe("");
  });

  it("passes an unwrapped chat intent through unchanged", () => {
    expect(formatIntent("what were we doing yesterday?")).toBe(
      "what were we doing yesterday?",
    );
  });

  it("leaves a partial or trailing-content wrapper alone rather than half-parsing it", () => {
    expect(formatIntent('<task id="task_1">Title</task> plus trailing')).toBe(
      '<task id="task_1">Title</task> plus trailing',
    );
    expect(formatIntent("<task>Title</task>")).toBe("<task>Title</task>");
  });
});

describe("formatReviewPolicy", () => {
  it("renders the require_human sentinel in prose", () => {
    expect(formatReviewPolicy("require_human")).toBe("require human");
  });

  it("renders everything else — including legacy null/undefined — as auto-done", () => {
    expect(formatReviewPolicy("auto_done")).toBe("auto-done");
    expect(formatReviewPolicy(null)).toBe("auto-done");
    expect(formatReviewPolicy(undefined)).toBe("auto-done");
    expect(formatReviewPolicy("something_new")).toBe("auto-done");
  });
});
