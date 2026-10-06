import { describe, expect, it } from "vitest";
import { categoryAccent, formatTool, normalizeToolName } from "./tool-format";

describe("formatTool — session_search shape detection", () => {
  it("discover: query → 'Recalled past conversation' with quoted detail", () => {
    const display = formatTool(
      "mcp__beevibe__session_search",
      JSON.stringify({ query: "auth refactor" }),
    );
    expect(display.label).toBe("Recalled past conversation");
    expect(display.detail).toBe('"auth refactor"');
    expect(display.category).toBe("memory");
    expect(display.icon.displayName ?? "").toMatch(/History/);
  });

  it("scroll: session_id + around_message_id → 'Scrolled back'", () => {
    const display = formatTool(
      "session_search",
      JSON.stringify({ session_id: "sess_abc123def", around_message_id: "evt_xyz" }),
    );
    expect(display.label).toBe("Scrolled back");
    expect(display.detail).toBe("#abc123");
    expect(display.category).toBe("memory");
  });

  it("read: session_id alone → 'Re-read a past session'", () => {
    const display = formatTool(
      "session_search",
      JSON.stringify({ session_id: "sess_abc123def456" }),
    );
    expect(display.label).toBe("Re-read a past session");
    expect(display.detail).toBe("#abc123");
  });

  it("browse: empty args → 'Browsed recent sessions'", () => {
    const display = formatTool("session_search", JSON.stringify({}));
    expect(display.label).toBe("Browsed recent sessions");
    expect(display.detail).toBe("");
  });

  it("browse: actual runtime empty-input shape ('{}') falls back to browse label", () => {
    // describeToolInput emits "{}" for session_search() with no args.
    const display = formatTool("session_search", "{}");
    expect(display.label).toBe("Browsed recent sessions");
  });

  it("discover with whitespace-only query falls back to browse", () => {
    const display = formatTool(
      "session_search",
      JSON.stringify({ query: "   " }),
    );
    expect(display.label).toBe("Browsed recent sessions");
  });

  it("mcp__ prefix is stripped before name matching", () => {
    const display = formatTool(
      "mcp__beevibe__session_search",
      JSON.stringify({ query: "x" }),
    );
    expect(display.label).toBe("Recalled past conversation");
  });

  // tool_call rows from Claude Code's stream-json arrive as a stringified
  // function-call signature, NOT JSON. The discover/scroll/read inference
  // has to work against both.
  it("discover from function-call signature (Claude Code stream format)", () => {
    const display = formatTool(
      "mcp__beevibe__session_search",
      'mcp__beevibe__session_search(query="daemon timestamp", limit=5)',
    );
    expect(display.label).toBe("Recalled past conversation");
    expect(display.detail).toBe('"daemon timestamp"');
  });

  it("scroll from function-call signature", () => {
    const display = formatTool(
      "session_search",
      'session_search(session_id="sess_abc123def", around_message_id="evt_xyz", window=10)',
    );
    expect(display.label).toBe("Scrolled back");
    expect(display.detail).toBe("#abc123");
  });

  it("read from function-call signature", () => {
    const display = formatTool(
      "session_search",
      'session_search(session_id="sess_abc123def456")',
    );
    expect(display.label).toBe("Re-read a past session");
    expect(display.detail).toBe("#abc123");
  });

  it("handles single-quoted values in the call signature", () => {
    const display = formatTool(
      "session_search",
      "session_search(query='auth refactor', limit=3)",
    );
    expect(display.label).toBe("Recalled past conversation");
    expect(display.detail).toBe('"auth refactor"');
  });

  it("escaped quotes inside call-signature values survive intact", () => {
    const display = formatTool(
      "session_search",
      'session_search(query="he said \\"hi\\"")',
    );
    expect(display.label).toBe("Recalled past conversation");
    expect(display.detail).toBe('"he said "hi""');
  });

  // The runtime adapter's describeToolInput
  // (packages/core/src/adapters/claude-code/stream-json.ts) emits a
  // BARE value when a PREFERRED_INPUT_FIELDS key matches, or when
  // the input has a single string-valued key. These are the actual
  // shapes that arrive in production for tool_call rows — the JSON /
  // call-signature paths above are defensive coverage for tool_result
  // rows and any future emitter.
  it("discover from bare query string (the production runtime shape)", () => {
    const display = formatTool("session_search", "daemon timestamp");
    expect(display.label).toBe("Recalled past conversation");
    expect(display.detail).toBe('"daemon timestamp"');
  });

  it("read from a bare session id (single-key input emit)", () => {
    const display = formatTool("session_search", "sess_abc123def");
    expect(display.label).toBe("Re-read a past session");
    expect(display.detail).toBe("#abc123");
  });

  it("bare empty / whitespace content falls through to browse", () => {
    expect(formatTool("session_search", "").label).toBe("Browsed recent sessions");
    expect(formatTool("session_search", "   ").label).toBe("Browsed recent sessions");
  });

  it("bare JSON-shaped content stays in browse (no accidental discover)", () => {
    // '{}' is the explicit empty-input emit; '[]' is just defensive.
    expect(formatTool("session_search", "{}").label).toBe("Browsed recent sessions");
    expect(formatTool("session_search", "[]").label).toBe("Browsed recent sessions");
  });
});

describe("formatTool — empty-args blobs render no stray detail", () => {
  // find_subordinates() takes no args, so describeToolInput emits "{}".
  // Without cleanup that rendered as "Surveyed the team {}" — the stray
  // braces are noise, so the detail should be blank.
  it("find_subordinates with empty '{}' args → 'Surveyed the team', no detail", () => {
    const display = formatTool("mcp__beevibe__find_subordinates", "{}");
    expect(display.label).toBe("Surveyed the team");
    expect(display.detail).toBe("");
    expect(display.category).toBe("team");
  });

  it("find_peers / find_up also drop the empty-object detail", () => {
    expect(formatTool("find_peers", "{}").detail).toBe("");
    expect(formatTool("find_up", "{ }").detail).toBe("");
  });

  it("empty object/array args carry no detail for any tool", () => {
    expect(formatTool("get_agent_profile", "{}").detail).toBe("");
    expect(formatTool("create_task", "[]").detail).toBe("");
  });

  it("non-empty args still render a detail", () => {
    expect(formatTool("Bash", "ls -la").detail).toBe("ls -la");
  });
});

// ── The dispatch table itself ──────────────────────────────────────────────
//
// `formatTool` is one long if-chain mapping tool name → verb label +
// category, and the chat panel's icon, accent colour and grouping all key
// off that mapping. A silent mislabel (a mesh tool landing in "other", a
// renamed tool falling through to the raw-name fallback) is invisible in
// code review but obvious in the UI, so the whole table is pinned here.

describe("formatTool — name → label/category table", () => {
  const cases: Array<[string, string, string]> = [
    // tool name, expected label, expected category
    ["ask", "Asked another agent", "mesh"],
    ["respond_ask", "Answered an ask", "mesh"],
    ["negotiate", "Negotiating with peer", "mesh"],
    ["respond_negotiate", "Negotiating with peer", "mesh"],
    ["report_blocker", "Reported a blocker", "mesh"],
    ["escalate_to_humans", "Escalated to humans", "mesh"],
    ["add_to_escalation", "Added to escalation", "mesh"],
    ["revise_task", "Revised a subordinate's task", "mesh"],
    ["create_subordinate_agent", "Spawned a specialist", "team"],
    ["create_task", "Minted a task", "team"],
    ["find_subordinates", "Surveyed the team", "team"],
    ["find_peers", "Surveyed the team", "team"],
    ["find_up", "Surveyed the team", "team"],
    ["get_agent_profile", "Read a peer's profile", "team"],
    ["check_work_status", "Checked work status", "task"],
    ["get_task", "Checked work status", "task"],
    ["list_work_products", "Checked work status", "task"],
    ["create_work_product", "Filed a work product", "task"],
    ["update_work_product", "Filed a work product", "task"],
    ["update_progress", "Updated progress", "task"],
    ["search_context", "Searched memory", "memory"],
    ["save_memory", "Saved a memory", "memory"],
    ["update_core_memory", "Updated core memory", "memory"],
    ["Read", "Read", "fs"],
    ["Write", "Wrote file", "fs"],
    ["Edit", "Edited file", "fs"],
    ["Bash", "Bash", "shell"],
    ["Glob", "Globbed paths", "search"],
    ["Grep", "Grepped", "search"],
    ["WebFetch", "Fetched URL", "search"],
    ["WebSearch", "Web search", "search"],
  ];

  it.each(cases)("%s → %s (%s)", (name, label, category) => {
    const display = formatTool(name, "x");
    expect(display.label).toBe(label);
    expect(display.category).toBe(category);
    expect(display.icon).toBeTruthy();
  });

  it("strips the mcp__<server>__ prefix before matching", () => {
    expect(formatTool("mcp__beevibe__create_task", "x").label).toBe("Minted a task");
  });

  it("matches ToolSearch on the raw name, before prefix stripping", () => {
    const display = formatTool("ToolSearch", "select:Read,Edit");
    expect(display.label).toBe("Selected tools");
    expect(display.category).toBe("other");
  });
});

describe("formatTool — unknown tools fall back to the humanized name", () => {
  it("snake_case becomes spaced words", () => {
    const display = formatTool("some_future_tool", "x");
    expect(display.label).toBe("some future tool");
    expect(display.category).toBe("other");
  });

  it("camelCase gets split on the case boundary", () => {
    expect(formatTool("someFutureTool", "x").label).toBe("some Future Tool");
  });

  it("degrades a bare mcp prefix to 'step' rather than an empty bubble", () => {
    // normalizeToolName eats the whole string, so the fallback reaches for
    // rawName — which fallbackLabel strips the same way, leaving the
    // "step" sentinel.
    expect(formatTool("mcp__beevibe__", "x").label).toBe("step");
  });

  it("labels a nameless step 'step' rather than rendering an empty bubble", () => {
    expect(formatTool(undefined, "x").label).toBe("step");
    expect(formatTool("   ", "x").label).toBe("step");
  });
});

describe("normalizeToolName", () => {
  it.each([
    ["mcp__beevibe__ask", "ask"],
    ["  mcp__beevibe__ask  ", "ask"],
    ["ask", "ask"],
    [undefined, ""],
    ["", ""],
  ])("%s → %s", (input, expected) => {
    expect(normalizeToolName(input)).toBe(expected);
  });

  it("only strips the first mcp prefix segment", () => {
    // The regex's [^_]+ can't span the double underscore, so a server name
    // containing one is left alone rather than over-stripped.
    expect(normalizeToolName("mcp__a__b__tool")).toBe("b__tool");
  });
});

describe("formatTool — detail cleaning", () => {
  it("inlines mcp prefixes, expands select:, and redacts task ids", () => {
    const detail = formatTool(
      "ToolSearch",
      "select:mcp__beevibe__get_task,task_AbC-123",
    ).detail;
    expect(detail).toBe("selected get task, task");
  });

  it("collapses runs of whitespace and spaces out commas", () => {
    expect(formatTool("Bash", "  ls   -la,-h  ").detail).toBe("ls -la, -h");
  });

  it("leaves underscores alone outside a select: blob", () => {
    expect(formatTool("Bash", "my_script.sh").detail).toBe("my_script.sh");
  });
});

describe("categoryAccent", () => {
  it.each([
    ["mesh", "text-hier-team bg-hier-team/15"],
    ["team", "text-hier-team bg-hier-team/10"],
    ["memory", "text-status-running bg-status-running/15"],
    ["task", "text-status-review bg-status-review/15"],
    ["fs", "text-foreground/80 bg-muted"],
    ["shell", "text-foreground/80 bg-muted"],
    ["search", "text-foreground/80 bg-muted"],
    ["other", "text-muted-foreground bg-muted"],
  ] as const)("%s accent", (category, expected) => {
    expect(categoryAccent(category)).toBe(expected);
  });
});

describe("formatTool — session_search with unparseable args", () => {
  it("treats a truncated JSON blob as no args (browse) instead of throwing", () => {
    // The stream can cut an args blob mid-object; safeParseJson swallows
    // the SyntaxError so the bubble still renders.
    const display = formatTool("session_search", '{"query": "auth refa');
    expect(display.category).toBe("memory");
    expect(display.label).toBeTruthy();
  });

  it("treats a JSON array blob as no args — only objects carry named args", () => {
    expect(formatTool("session_search", '["query"]').category).toBe("memory");
  });
});
