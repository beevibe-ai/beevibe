import { describe, expect, it } from "vitest";
import {
  lineageKey,
  parseUserMessageId,
  userMessageId,
} from "./session-search.js";

describe("lineageKey", () => {
  it("uses conversation_id when the session belongs to a chat thread", () => {
    expect(lineageKey({ id: "sess_tail", conversation_id: "sess_head" })).toBe(
      "sess_head",
    );
  });

  it("falls back to the session id when conversation_id is null", () => {
    expect(lineageKey({ id: "sess_task", conversation_id: null })).toBe(
      "sess_task",
    );
  });

  it("groups every turn of one chat thread under the same key", () => {
    const head = { id: "sess_head", conversation_id: "sess_head" };
    const tail = { id: "sess_tail", conversation_id: "sess_head" };
    expect(lineageKey(head)).toBe(lineageKey(tail));
  });
});

describe("userMessageId / parseUserMessageId", () => {
  it("round-trips a session id through the intent: marker", () => {
    const id = userMessageId("sess_abc");
    expect(id).toBe("intent:sess_abc");
    expect(parseUserMessageId(id)).toBe("sess_abc");
  });

  it("returns null for session_event row ids", () => {
    expect(parseUserMessageId("evt_123")).toBeNull();
  });

  it("returns null when the marker is not at the start", () => {
    expect(parseUserMessageId("evt_intent:sess_abc")).toBeNull();
  });

  it("returns an empty session id rather than null for a bare marker", () => {
    // scroll() passes this straight to the repo, which finds no row — the
    // parse step deliberately does not second-guess the caller.
    expect(parseUserMessageId("intent:")).toBe("");
  });
});
