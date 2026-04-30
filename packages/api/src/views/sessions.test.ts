import { describe, it, expect, vi } from "vitest";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { getSessionByShortId, AmbiguousShortIdError } from "./sessions.js";

function makePool(rows: unknown[]) {
  const query = vi.fn(async () => ({ rows }));
  return { query: query as unknown as Pool["query"] } as unknown as Pool;
}

describe("getSessionByShortId", () => {
  it("returns undefined when no matching session", async () => {
    const pool = makePool([]);
    expect(await getSessionByShortId(pool, "abc123")).toBeUndefined();
  });

  it("rejects malformed short_ids without hitting the DB", async () => {
    const pool = makePool([]);
    expect(await getSessionByShortId(pool, "abc/../etc")).toBeUndefined();
    expect((pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("throws AmbiguousShortIdError when 2+ rows share the prefix", async () => {
    const pool = makePool([
      sampleRow("sess_abc1230001"),
      sampleRow("sess_abc1230002"),
    ]);
    await expect(getSessionByShortId(pool, "abc123")).rejects.toBeInstanceOf(
      AmbiguousShortIdError,
    );
  });

  it("maps a single row into a SessionDisplay with empty briefing/transcript", async () => {
    const pool = makePool([sampleRow("sess_abcdef00ff")]);
    const session = await getSessionByShortId(pool, "abcdef");
    expect(session?.short_id).toBe("abcdef");
    expect(session?.task_title).toBe("Bill rewrite");
    expect(session?.agent_label).toBe("Beta");
    expect(session?.briefing.block_count).toBe(0);
    expect(session?.transcript).toEqual([]);
    expect(session?.ask_threads).toEqual([]);
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
    agent_label: "Beta",
    agent_hier: "team",
    task_title: "Bill rewrite",
  };
}
