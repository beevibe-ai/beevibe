import { describe, expect, it } from "vitest";
import {
  REPO_RUN_TRANSCRIPT_TO_SESSION_EVENT,
  sessionEventKindToTranscript,
  transcriptKindToSessionEvent,
  type RepoRunTranscriptKind,
} from "./repo-run.js";
import type { SessionEventKind } from "./session.js";

const TRANSCRIPT_KINDS: RepoRunTranscriptKind[] = ["log", "agent", "tool_call", "error"];
const SESSION_EVENT_KINDS: SessionEventKind[] = [
  "agent",
  "tool_call",
  "tool_result",
  "summary",
];

describe("transcript kind <-> session event kind", () => {
  it("folds the two sandbox-only kinds onto the session_event vocabulary", () => {
    // 'log' and 'error' have no session_event counterpart of their own.
    expect(transcriptKindToSessionEvent("log")).toBe("summary");
    expect(transcriptKindToSessionEvent("error")).toBe("tool_result");
  });

  it("passes the two shared kinds through unchanged", () => {
    expect(transcriptKindToSessionEvent("agent")).toBe("agent");
    expect(transcriptKindToSessionEvent("tool_call")).toBe("tool_call");
  });

  it("round-trips every transcript kind", () => {
    // The whole reason the inverse is derived rather than hand-written:
    // the daemon writes with the forward map and the /repo-runs reader
    // inverts it, so a non-bijective table silently mislabels the
    // playground transcript.
    for (const kind of TRANSCRIPT_KINDS) {
      expect(sessionEventKindToTranscript(transcriptKindToSessionEvent(kind))).toBe(kind);
    }
  });

  it("round-trips every session event kind", () => {
    for (const kind of SESSION_EVENT_KINDS) {
      expect(transcriptKindToSessionEvent(sessionEventKindToTranscript(kind))).toBe(kind);
    }
  });

  it("maps each transcript kind to a distinct session event kind", () => {
    const mapped = TRANSCRIPT_KINDS.map(transcriptKindToSessionEvent);
    expect(new Set(mapped).size).toBe(TRANSCRIPT_KINDS.length);
  });

  it("covers every transcript kind in the forward table", () => {
    expect(Object.keys(REPO_RUN_TRANSCRIPT_TO_SESSION_EVENT).sort()).toEqual(
      [...TRANSCRIPT_KINDS].sort(),
    );
  });
});
