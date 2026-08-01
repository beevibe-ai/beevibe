import { describe, expect, it } from "vitest";
import { lineageKey, userMessageId } from "./session-search.js";

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

describe("userMessageId", () => {
  it("prefixes the session id with the intent: marker", () => {
    // Must stay byte-identical to userMessageIdExpr() in
    // adapters/postgres/session-search-repo.ts — scroll() matches the
    // anchor id against the SQL-built string by equality.
    expect(userMessageId("sess_abc")).toBe("intent:sess_abc");
  });
});
