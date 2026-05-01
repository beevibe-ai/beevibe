import { describe, it, expect } from "vitest";
import { getSessionByShortId, AmbiguousShortIdError } from "./sessions.js";
import { makeMockPool } from "./test-helpers.js";

describe("getSessionByShortId", () => {
  it("returns undefined when no matching session", async () => {
    const pool = makeMockPool([]);
    expect(await getSessionByShortId(pool, "abc123")).toBeUndefined();
  });

  it("rejects malformed short_ids without hitting the DB", async () => {
    const pool = makeMockPool([]);
    expect(await getSessionByShortId(pool, "abc/../etc")).toBeUndefined();
    expect(pool._spy.mock.calls).toHaveLength(0);
  });

  it("throws AmbiguousShortIdError when 2+ rows share the prefix", async () => {
    const pool = makeMockPool([
      sampleRow("sess_abc1230001"),
      sampleRow("sess_abc1230002"),
    ]);
    await expect(getSessionByShortId(pool, "abc123")).rejects.toBeInstanceOf(
      AmbiguousShortIdError,
    );
  });

  it("maps a single row into a SessionDisplay with empty briefing/transcript", async () => {
    const pool = makeMockPool([sampleRow("sess_abcdef00ff")]);
    const session = await getSessionByShortId(pool, "abcdef");
    expect(session?.short_id).toBe("abcdef");
    expect(session?.task_title).toBe("Bill rewrite");
    expect(session?.agent_label).toBe("Beta");
    expect(session?.briefing.block_count).toBe(0);
    expect(session?.transcript).toEqual([]);
    expect(session?.ask_threads).toEqual([]);
  });

  it("returns the persisted briefing JSONB when present (#45 item 3a)", async () => {
    const briefing = {
      block_count: 2,
      fact_count: 1,
      token_count: 42,
      blocks: [{ name: "persona", chars: 12, preview: "infra eng" }],
      facts: [{ scope: "ic" as const, content: "uses pnpm", score: 0 }],
    };
    const row = { ...sampleRow("sess_briefed01"), briefing };
    const pool = makeMockPool([row]);
    const session = await getSessionByShortId(pool, "briefe");
    expect(session?.briefing).toEqual(briefing);
  });
});

function sampleRow(id: string) {
  return {
    id,
    agent_id: "agt_team",
    task_id: "task_001",
    type: "task",
    status: "running",
    intent: "do the work",
    workspace_path: "/tmp/wt",
    cli_session_id: "cli_xx",
    started_at: new Date("2026-04-30T11:00:00Z"),
    completed_at: null,
    briefing: null,
    agent_label: "Beta",
    agent_hier: "team",
    task_title: "Bill rewrite",
  };
}
