import { describe, it, expect } from "vitest";
import {
  AmbiguousShortIdError,
  getConversationByShortId,
  getSessionByShortId,
  toSessionUsageDisplay,
} from "./sessions.js";
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

describe("toSessionUsageDisplay", () => {
  it("returns undefined when usage is null (older sessions pre-M9.8)", () => {
    expect(toSessionUsageDisplay(null)).toBeUndefined();
    expect(toSessionUsageDisplay(undefined)).toBeUndefined();
  });

  it("populates every numeric field, defaulting missing slices to 0", () => {
    const out = toSessionUsageDisplay({
      cost_usd: 0.1234,
      input_tokens: 100,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 800,
      model: "claude-opus-4-7",
    });
    expect(out).toEqual({
      cost_usd: 0.1234,
      cache_hit_ratio: 800 / (100 + 200 + 800), // 0.7272...
      input_tokens: 100,
      output_tokens: 500,
      cache_creation_tokens: 200,
      cache_read_tokens: 800,
      total_input_tokens: 1100,
      model: "claude-opus-4-7",
    });
  });

  it("computes cache_hit_ratio as cache_read / total_input", () => {
    // 90% cache hit — the warm-second-session target case.
    const warm = toSessionUsageDisplay({
      input_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 900,
    });
    expect(warm?.cache_hit_ratio).toBeCloseTo(0.9, 5);

    // 0% cache hit — cold first session, no cached prefix.
    const cold = toSessionUsageDisplay({
      input_tokens: 1000,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 0,
    });
    expect(cold?.cache_hit_ratio).toBe(0);
  });

  it("avoids NaN when there's no input at all (degenerate but possible)", () => {
    // E.g., a session that errored before any tokens were exchanged.
    // Naïve `cache_read / total_input` would divide by zero; we
    // guard with `total > 0 ? ratio : 0`.
    const out = toSessionUsageDisplay({});
    expect(out?.cache_hit_ratio).toBe(0);
    expect(out?.total_input_tokens).toBe(0);
    expect(Number.isFinite(out?.cache_hit_ratio ?? 0)).toBe(true);
  });

  it("falls back to 'unknown' model when missing or empty", () => {
    expect(toSessionUsageDisplay({})?.model).toBe("unknown");
    expect(toSessionUsageDisplay({ model: "" })?.model).toBe("unknown");
    expect(toSessionUsageDisplay({ model: "claude-sonnet-4-6" })?.model).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("defaults cost_usd to 0 when missing — UI can render '$0.00' instead of '—'", () => {
    expect(toSessionUsageDisplay({})?.cost_usd).toBe(0);
  });

  it("total_input_tokens is the sum of all three input slices (per SessionUsage contract)", () => {
    const out = toSessionUsageDisplay({
      input_tokens: 11,
      cache_creation_input_tokens: 22,
      cache_read_input_tokens: 33,
    });
    expect(out?.total_input_tokens).toBe(11 + 22 + 33);
  });
});

describe("getSessionByShortId — usage plumbing", () => {
  it("populates session.usage when the row carries it", async () => {
    const row = {
      ...sampleRow("sess_usageff01"),
      usage: {
        cost_usd: 0.05,
        input_tokens: 50,
        output_tokens: 200,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 350,
        model: "claude-opus-4-7",
      },
    };
    const pool = makeMockPool([row]);
    const session = await getSessionByShortId(pool, "usagef");
    expect(session?.usage?.cost_usd).toBe(0.05);
    expect(session?.usage?.model).toBe("claude-opus-4-7");
    expect(session?.usage?.total_input_tokens).toBe(500);
    expect(session?.usage?.cache_hit_ratio).toBeCloseTo(350 / 500, 5);
  });

  it("leaves session.usage undefined when the row has null usage", async () => {
    const pool = makeMockPool([{ ...sampleRow("sess_nousageff"), usage: null }]);
    const session = await getSessionByShortId(pool, "nousag");
    expect(session?.usage).toBeUndefined();
  });
});

describe("getConversationByShortId", () => {
  it("returns undefined when no matching session", async () => {
    const pool = makeMockPool([[], []]);
    expect(await getConversationByShortId(pool, "abc123")).toBeUndefined();
  });

  it("rejects malformed short_ids without hitting the DB", async () => {
    const pool = makeMockPool([[], []]);
    expect(await getConversationByShortId(pool, "abc/../etc")).toBeUndefined();
    expect(pool._spy.mock.calls).toHaveLength(0);
  });

  it("throws AmbiguousShortIdError when the resolve query matches 2+ rows", async () => {
    const pool = makeMockPool([
      [
        resolveRow("sess_abc1230001", "sess_abc1230001"),
        resolveRow("sess_abc1230002", "sess_abc1230002"),
      ],
    ]);
    await expect(getConversationByShortId(pool, "abc123")).rejects.toBeInstanceOf(
      AmbiguousShortIdError,
    );
  });

  it("collapses all chat turns sharing a conversation_id into one chronological thread", async () => {
    const head = "sess_head00aaaa";
    const turns = [
      { ...sampleRow(head), type: "chat", status: "succeeded", intent: "first question" },
      {
        ...sampleRow("sess_turn02bbbb"),
        type: "chat",
        status: "succeeded",
        intent: "second question",
      },
      {
        ...sampleRow("sess_turn03cccc"),
        type: "chat",
        status: "running",
        intent: "third question",
      },
    ];
    const pool = makeMockPool([[resolveRow(head, head, "chat")], turns]);
    const conv = await getConversationByShortId(pool, "head00");
    expect(conv?.conversation_id).toBe(head);
    expect(conv?.short_id).toBe("head00");
    expect(conv?.type).toBe("chat");
    expect(conv?.task_id).toBeUndefined();
    expect(conv?.agent_label).toBe("Beta");
    expect(conv?.turns).toHaveLength(3);
    expect(conv?.turns.map((t) => t.intent)).toEqual([
      "first question",
      "second question",
      "third question",
    ]);
    // status reflects the LATEST turn (chronological tail), not the head.
    expect(conv?.status).toBe("running");
  });

  it("resolves a non-chat session (null conversation_id) to a single-turn conversation on its own id", async () => {
    const id = "sess_task00aaaa";
    const pool = makeMockPool([
      [resolveRow(id, null, "task", "task_001")],
      [{ ...sampleRow(id), type: "task", status: "running" }],
    ]);
    const conv = await getConversationByShortId(pool, "task00");
    expect(conv?.conversation_id).toBe(id);
    expect(conv?.short_id).toBe("task00");
    expect(conv?.type).toBe("task");
    expect(conv?.task_id).toBe("task_001");
    expect(conv?.turns).toHaveLength(1);
  });

  it("aggregates per-turn usage into one conversation-level total", async () => {
    const head = "sess_usagehead1";
    const turns = [
      {
        ...sampleRow(head),
        type: "chat",
        usage: {
          cost_usd: 0.01,
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 0,
          model: "claude-opus-4-8",
        },
      },
      {
        ...sampleRow("sess_usageturn2"),
        type: "chat",
        usage: {
          cost_usd: 0.02,
          input_tokens: 0,
          output_tokens: 70,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 300,
          model: "claude-opus-4-8",
        },
      },
    ];
    const pool = makeMockPool([[resolveRow(head, head, "chat")], turns]);
    const conv = await getConversationByShortId(pool, "usageh");
    expect(conv?.usage?.cost_usd).toBeCloseTo(0.03, 5);
    expect(conv?.usage?.input_tokens).toBe(100);
    expect(conv?.usage?.output_tokens).toBe(120);
    expect(conv?.usage?.cache_creation_tokens).toBe(200);
    expect(conv?.usage?.cache_read_tokens).toBe(300);
    expect(conv?.usage?.total_input_tokens).toBe(600); // 100 + 200 + 300
    expect(conv?.usage?.cache_hit_ratio).toBeCloseTo(300 / 600, 5);
    expect(conv?.usage?.model).toBe("claude-opus-4-8");
  });

  it("omits conversation usage when no turn carried any", async () => {
    const head = "sess_nousagehd";
    const pool = makeMockPool([
      [resolveRow(head, head, "chat")],
      [{ ...sampleRow(head), type: "chat", usage: null }],
    ]);
    const conv = await getConversationByShortId(pool, "nousag");
    expect(conv?.usage).toBeUndefined();
  });
});

function resolveRow(
  id: string,
  conversation_id: string | null,
  type = "chat",
  task_id: string | null = null,
) {
  return { id, conversation_id, type, task_id, agent_id: "agt_team" };
}

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
    usage: null,
  };
}
