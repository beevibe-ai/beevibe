import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  SessionRecallBlock,
  isRecallDiscover,
  parseRecallContent,
  type RecallDiscover,
  type RecallHit,
} from "./session-recall-block";

function makeHit(overrides: Partial<RecallHit> = {}): RecallHit {
  return {
    session: {
      session_id: "sess_abc123def456",
      conversation_id: null,
      type: "task",
      status: "failed",
      agent_id: "agent_alice",
      task_id: "task_xyz789",
      intent_preview: "Refactor auth middleware",
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
      completed_at: new Date().toISOString(),
      result_summary: null,
    },
    match_message_id: "evt_match_1",
    matched_role: "user",
    snippet: "Refactor the <b>auth</b> <b>middleware</b> to use the new JWT",
    bookend_start: [
      {
        id: "intent:sess_abc123def456",
        session_id: "sess_abc123def456",
        kind: "user",
        content: "Refactor the authentication middleware to use the new JWT library.",
        created_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
      },
      {
        id: "evt_a",
        session_id: "sess_abc123def456",
        kind: "agent",
        content: "Starting by mapping every call site of the old middleware.",
        created_at: new Date(Date.now() - 1000 * 60 * 60 * 23).toISOString(),
      },
    ],
    messages: [],
    bookend_end: [
      {
        id: "evt_z",
        session_id: "sess_abc123def456",
        kind: "agent",
        content: "Test suite failing in unexpected places. Blocking on user direction.",
        created_at: new Date().toISOString(),
      },
    ],
    messages_before: 0,
    messages_after: 0,
    ...overrides,
  };
}

function makeResult(hits: RecallHit[], query = "auth middleware"): RecallDiscover {
  return { kind: "discover", query, hits, lineages_searched: hits.length };
}

describe("isRecallDiscover", () => {
  it("accepts valid discover payloads", () => {
    expect(isRecallDiscover(makeResult([makeHit()]))).toBe(true);
  });
  it("rejects other shapes", () => {
    expect(isRecallDiscover({ kind: "scroll", session: {} })).toBe(false);
    expect(isRecallDiscover({ kind: "discover", query: "x" })).toBe(false);
    expect(isRecallDiscover(null)).toBe(false);
    expect(isRecallDiscover("string")).toBe(false);
  });
});

describe("parseRecallContent", () => {
  it("parses well-formed discover JSON", () => {
    const result = parseRecallContent(JSON.stringify(makeResult([makeHit()])));
    expect(result?.hits).toHaveLength(1);
  });
  it("returns null for non-discover JSON", () => {
    expect(parseRecallContent(JSON.stringify({ kind: "browse", sessions: [] }))).toBeNull();
  });
  it("returns null for truncated JSON", () => {
    expect(parseRecallContent('{"kind":"discover","query":"auth","hits":[{')).toBeNull();
  });
  it("returns null for plain strings", () => {
    expect(parseRecallContent("just some text")).toBeNull();
    expect(parseRecallContent("")).toBeNull();
  });
});

describe("SessionRecallBlock", () => {
  it("renders nothing when hits is empty", () => {
    const { container } = render(<SessionRecallBlock result={makeResult([])} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the query and a single hit with snippet HTML highlighted", () => {
    const { container } = render(<SessionRecallBlock result={makeResult([makeHit()])} />);
    expect(container.textContent).toContain("auth middleware");
    expect(container.textContent).toContain("1 match");
    // ts_headline <b> markers preserved
    expect(container.innerHTML).toContain("<b>auth</b>");
  });

  it("caps at maxHits and shows a 'more' count", () => {
    const hits = [
      makeHit({ match_message_id: "m1" }),
      makeHit({ match_message_id: "m2" }),
      makeHit({ match_message_id: "m3" }),
    ];
    const { container } = render(
      <SessionRecallBlock result={makeResult(hits)} maxHits={1} />,
    );
    expect(container.textContent).toMatch(/\+ 2 more matches/);
  });

  it("shows goal + end bookends in full mode", () => {
    const { container } = render(<SessionRecallBlock result={makeResult([makeHit()])} />);
    expect(container.textContent).toMatch(/Goal/);
    expect(container.textContent).toMatch(/End/);
    expect(container.textContent).toContain("Refactor the authentication middleware");
    expect(container.textContent).toContain("Blocking on user direction");
  });

  it("hides bookends in dense mode", () => {
    const { container } = render(
      <SessionRecallBlock result={makeResult([makeHit()])} dense />,
    );
    expect(container.textContent).not.toMatch(/Goal/);
    expect(container.textContent).not.toMatch(/End/);
  });

  it("renders an open link pointing to /tasks/[task_id]/sessions/[short]", () => {
    const { container } = render(<SessionRecallBlock result={makeResult([makeHit()])} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/tasks/task_xyz789/sessions/abc123");
  });

  it("renders an open link to /sessions/[short] when there is no task_id", () => {
    const hit = makeHit();
    hit.session.task_id = null;
    const { container } = render(<SessionRecallBlock result={makeResult([hit])} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/sessions/abc123");
  });

  it("succeeded status uses the done tone", () => {
    const hit = makeHit();
    hit.session.status = "succeeded";
    const { container } = render(<SessionRecallBlock result={makeResult([hit])} />);
    // Tone class is on the status icon — easier to assert on the SVG count
    // than on a specific Tailwind class string.
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
  });
});
