/**
 * Transcript-assembly tests for the chat route's exported helpers.
 *
 * GET /chat rehydrates the chat surface by pulling the recent-N sessions
 * flat out of Postgres and rebuilding conversations from them. The three
 * functions under test are that reconstruction: chain sessions by
 * `prior_session_id`, pick a message for a failed turn, and flatten a
 * chain into rendered messages. They're pure, so the interesting cases —
 * a corrupt pointer cycle, a chain that runs off the edge of the fetch
 * window — are reachable here without a database.
 */
import { describe, expect, it } from "vitest";
import {
  SYSTEM_WAKE_INTENT_CLOSE,
  SYSTEM_WAKE_INTENT_OPEN,
} from "@beevibe/core";
import { runtimeMissingError } from "@beevibe/core/adapters/runtime-registry";
import {
  chainToMessages,
  failureMessageFor,
  groupIntoConversations,
  type ChatSession,
} from "./chat.js";

/** `t` doubles as both the created_at offset and a readable ordering key. */
function s(id: string, t: number, overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    intent: `intent ${id}`,
    status: "succeeded",
    created_at: new Date(1_700_000_000_000 + t * 1000),
    ...overrides,
  };
}

const ids = (chains: ReturnType<typeof groupIntoConversations>) =>
  chains.map((c) => c.sessions.map((x) => x.id));

describe("groupIntoConversations", () => {
  it("returns nothing for no sessions", () => {
    expect(groupIntoConversations([])).toEqual([]);
  });

  it("puts a lone rootless session in its own chain", () => {
    const chains = groupIntoConversations([s("a", 0)]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.head_id).toBe("a");
  });

  it("links a multi-turn chain under its head", () => {
    const chains = groupIntoConversations([
      s("a", 0),
      s("b", 1, { prior_session_id: "a" }),
      s("c", 2, { prior_session_id: "b" }),
    ]);

    expect(chains).toHaveLength(1);
    expect(chains[0]!.head_id).toBe("a");
    expect(ids(chains)).toEqual([["a", "b", "c"]]);
  });

  it("keeps separate conversations apart", () => {
    const chains = groupIntoConversations([
      s("a", 0),
      s("b", 1, { prior_session_id: "a" }),
      s("x", 2),
    ]);

    expect(chains).toHaveLength(2);
    expect(new Set(chains.map((c) => c.head_id))).toEqual(new Set(["a", "x"]));
  });

  it("orders sessions within a chain oldest-first regardless of input order", () => {
    // The repo returns newest-first; the transcript reads oldest-first.
    const chains = groupIntoConversations([
      s("c", 2, { prior_session_id: "b" }),
      s("a", 0),
      s("b", 1, { prior_session_id: "a" }),
    ]);

    expect(ids(chains)).toEqual([["a", "b", "c"]]);
  });

  it("orders conversations newest-activity first", () => {
    // Chain "old" started later than "new" began, but "new" has the most
    // recent turn — recency of activity is what the sidebar sorts on.
    const chains = groupIntoConversations([
      s("old", 0),
      s("old2", 1, { prior_session_id: "old" }),
      s("new", 2),
      s("new2", 9, { prior_session_id: "new" }),
    ]);

    expect(chains.map((c) => c.head_id)).toEqual(["new", "old"]);
  });

  it("starts a new chain when prior_session_id points outside the window", () => {
    // The fetch is capped at CHAT_FETCH_LIMIT rows, so a long conversation
    // can be truncated mid-chain. Surfacing the fragment beats dropping it.
    const chains = groupIntoConversations([
      s("b", 1, { prior_session_id: "a_not_fetched" }),
      s("c", 2, { prior_session_id: "b" }),
    ]);

    expect(chains).toHaveLength(1);
    expect(chains[0]!.head_id).toBe("b");
    expect(ids(chains)).toEqual([["b", "c"]]);
  });

  it("assigns every session to exactly one chain", () => {
    const sessions = [
      s("a", 0),
      s("b", 1, { prior_session_id: "a" }),
      s("c", 2, { prior_session_id: "b" }),
      s("x", 3),
      s("y", 4, { prior_session_id: "x" }),
      s("orphan", 5, { prior_session_id: "gone" }),
    ];

    const seen = groupIntoConversations(sessions).flatMap((c) =>
      c.sessions.map((x) => x.id),
    );

    expect(seen.sort()).toEqual(sessions.map((x) => x.id).sort());
    expect(new Set(seen).size).toBe(sessions.length);
  });

  it("survives a self-referential pointer instead of hanging", () => {
    // Only reachable through data corruption, but the whole chat history
    // endpoint dies with it if the walk doesn't terminate.
    const chains = groupIntoConversations([s("a", 0, { prior_session_id: "a" })]);

    expect(chains).toHaveLength(1);
    expect(chains[0]!.sessions.map((x) => x.id)).toEqual(["a"]);
  });

  it("survives a multi-node pointer cycle", () => {
    const chains = groupIntoConversations([
      s("a", 0, { prior_session_id: "c" }),
      s("b", 1, { prior_session_id: "a" }),
      s("c", 2, { prior_session_id: "b" }),
    ]);

    // One chain, all three present, anchored somewhere inside the cycle.
    expect(chains).toHaveLength(1);
    expect(chains[0]!.sessions.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(["a", "b", "c"]).toContain(chains[0]!.head_id);
  });

  it("keeps a cycle from swallowing unrelated conversations", () => {
    const chains = groupIntoConversations([
      s("a", 0, { prior_session_id: "b" }),
      s("b", 1, { prior_session_id: "a" }),
      s("clean", 2),
    ]);

    expect(chains).toHaveLength(2);
    expect(ids(chains).map((c) => c.length).sort()).toEqual([1, 2]);
  });

  it("resolves a deep chain to a single head", () => {
    // Exercises the memoized ancestor short-circuit: each session walks
    // up until it hits an already-resolved node.
    const deep = Array.from({ length: 200 }, (_, i) =>
      s(`s${i}`, i, i === 0 ? {} : { prior_session_id: `s${i - 1}` }),
    );

    const chains = groupIntoConversations(deep);

    expect(chains).toHaveLength(1);
    expect(chains[0]!.head_id).toBe("s0");
    expect(chains[0]!.sessions).toHaveLength(200);
  });
});

describe("failureMessageFor", () => {
  const POINTER = /beevibe-daemon start/;

  it("prefers a real error over the result summary", () => {
    expect(
      failureMessageFor({ error: "ENOSPC on /tmp", result_summary: "whatever" }),
    ).toBe("ENOSPC on /tmp");
  });

  it("trims the error before using it", () => {
    expect(failureMessageFor({ error: "  ENOSPC  " })).toBe("ENOSPC");
  });

  it("falls back to the summary when there is no error", () => {
    expect(failureMessageFor({ result_summary: "ran out of context" })).toBe(
      "ran out of context",
    );
  });

  it("skips a bare CLI-exit error in favour of the summary", () => {
    // "CLI exited with code 1" tells the user nothing actionable.
    expect(
      failureMessageFor({
        error: "CLI exited with code 1",
        result_summary: "the repo had no package.json",
      }),
    ).toBe("the repo had no package.json");
  });

  it.each([
    "CLI exited with code 1",
    "CLI exited with code -9",
    "CLI exited with code null",
  ])("points at the daemon log when both sides are just %s", (bare) => {
    expect(failureMessageFor({ error: bare, result_summary: bare })).toMatch(POINTER);
  });

  it.each([
    ["both absent", {}],
    ["both null", { error: null, result_summary: null }],
    ["both whitespace", { error: "   ", result_summary: "  " }],
  ])("points at the daemon log when %s", (_label, session) => {
    expect(failureMessageFor(session)).toMatch(POINTER);
  });

  it("rewrites the daemon's runtime-missing throw into something actionable", () => {
    // Produced by the daemon's spawner; the user needs to be told which
    // CLI to install, not shown the internal dispatch-payload wording.
    const msg = failureMessageFor({ error: runtimeMissingError("codex") });

    expect(msg).toContain("codex");
    expect(msg).toContain("beevibe-daemon sync");
    expect(msg).not.toContain("dispatch payload");
  });

  it("prefers the runtime-missing rewrite over a usable summary", () => {
    const msg = failureMessageFor({
      error: runtimeMissingError("claude"),
      result_summary: "some other explanation",
    });

    expect(msg).toContain("isn't installed");
  });

  it("leaves an error that merely mentions a runtime alone", () => {
    const raw = "No runtime registered for something else entirely";
    expect(failureMessageFor({ error: raw })).toBe(raw);
  });
});

describe("chainToMessages", () => {
  const chain = (sessions: ChatSession[]) => ({ head_id: sessions[0]!.id, sessions });

  it("renders a completed turn as a user message then an agent message", () => {
    const msgs = chainToMessages(
      chain([s("a", 0, { intent: "add auth", result_summary: "done" })]),
    );

    expect(msgs).toEqual([
      { id: "u_a", role: "user", content: "add auth" },
      { id: "a_a", role: "agent", content: "done", session_id: "a" },
    ]);
  });

  it("emits only the user message while a turn is still running", () => {
    // No summary yet — the pending turn shows the user's side alone.
    const msgs = chainToMessages(chain([s("a", 0, { status: "running" })]));

    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
  });

  it("replaces the agent turn with a failure message when the session failed", () => {
    const msgs = chainToMessages(
      chain([
        s("a", 0, {
          status: "failed",
          error: "ENOSPC",
          result_summary: "ignored once it failed",
        }),
      ]),
    );

    expect(msgs[1]).toEqual({
      id: "a_a",
      role: "agent",
      content: "ENOSPC",
      session_id: "a",
    });
  });

  it("still shows a failure message when the failed session has no summary", () => {
    const msgs = chainToMessages(chain([s("a", 0, { status: "failed" })]));

    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.content).toMatch(/beevibe-daemon start/);
  });

  it("renders a watch-fired turn as a system message carrying the summary", () => {
    // The agent resumes with the full wrapped intent; the user only needs
    // to know *why* their agent suddenly started running.
    const intent = `${SYSTEM_WAKE_INTENT_OPEN}task tsk_1 finished\n\nDecide next steps.${SYSTEM_WAKE_INTENT_CLOSE}`;
    const msgs = chainToMessages(
      chain([s("w", 0, { intent, result_summary: "picked it up" })]),
    );

    expect(msgs[0]).toEqual({
      id: "w_w",
      role: "system",
      content: "task tsk_1 finished",
      session_id: "w",
    });
    expect(msgs[1]!.role).toBe("agent");
  });

  it("strips the wake wrapper even without the agent-facing prompt", () => {
    const intent = `${SYSTEM_WAKE_INTENT_OPEN}tsk_1 done${SYSTEM_WAKE_INTENT_CLOSE}`;
    const msgs = chainToMessages(chain([s("w", 0, { intent })]));

    expect(msgs[0]!.content).toBe("tsk_1 done");
  });

  it("flattens a whole chain in order", () => {
    const msgs = chainToMessages(
      chain([
        s("a", 0, { intent: "one", result_summary: "r1" }),
        s("b", 1, { intent: "two", prior_session_id: "a", result_summary: "r2" }),
      ]),
    );

    expect(msgs.map((m) => m.content)).toEqual(["one", "r1", "two", "r2"]);
  });

  it("gives every message a session-derived id, unique within the chain", () => {
    const msgs = chainToMessages(
      chain([
        s("a", 0, { result_summary: "r1" }),
        s("b", 1, { result_summary: "r2" }),
      ]),
    );

    expect(msgs.map((m) => m.id)).toEqual(["u_a", "a_a", "u_b", "a_b"]);
  });

  it("lifts an open_view directive out of the summary text", () => {
    const msgs = chainToMessages(
      chain([s("a", 0, { result_summary: 'Here you go.<open_view path="/tasks" />' })]),
    );

    const agent = msgs[1]!;
    expect(agent.content).not.toContain("open_view");
    expect(agent.open_view).toEqual({ path: "/tasks" });
  });

  it("omits directive keys entirely when the summary has none", () => {
    const msgs = chainToMessages(chain([s("a", 0, { result_summary: "plain" })]));

    expect(Object.keys(msgs[1]!).sort()).toEqual(["content", "id", "role", "session_id"]);
  });

  it("still emits the agent turn when the summary is nothing but a directive", () => {
    // The emptiness check is on the raw summary, not the stripped text,
    // so a directive-only turn survives with empty content. That's what
    // carries the directive to the client — dropping it would swallow
    // the view switch.
    const msgs = chainToMessages(
      chain([s("a", 0, { result_summary: '<open_view path="/tasks" />' })]),
    );

    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({
      role: "agent",
      content: "",
      open_view: { path: "/tasks" },
    });
  });

  it("emits no agent turn when the summary is an empty string", () => {
    const msgs = chainToMessages(chain([s("a", 0, { result_summary: "" })]));

    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
  });

  it("returns nothing for an empty chain", () => {
    expect(chainToMessages({ head_id: "a", sessions: [] })).toEqual([]);
  });
});
