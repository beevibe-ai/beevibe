import { describe, expect, it } from "vitest";
import {
  categoryAccent,
  formatTool,
  normalizeToolName,
  type ToolCategory,
} from "./tool-format";

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

  it("malformed JSON args fall back to browse rather than throwing", () => {
    // Starts with '{' so the JSON path is attempted, JSON.parse throws, the
    // catch returns null, and with no call-signature match we land on browse.
    expect(formatTool("session_search", '{"query": bad}').label).toBe(
      "Browsed recent sessions",
    );
  });

  it("JSON that parses to a non-object is treated as no args", () => {
    // safeParseJson only returns object shapes; a bare literal → null → browse.
    expect(formatTool("session_search", "42").label).toBe("Recalled past conversation");
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

describe("normalizeToolName", () => {
  it("strips the mcp__<server>__ prefix", () => {
    expect(normalizeToolName("mcp__beevibe__ask")).toBe("ask");
  });

  it("trims surrounding whitespace before stripping", () => {
    expect(normalizeToolName("  mcp__beevibe__create_task  ")).toBe("create_task");
  });

  it("leaves a bare tool name untouched", () => {
    expect(normalizeToolName("Bash")).toBe("Bash");
  });

  it("returns an empty string for undefined input", () => {
    expect(normalizeToolName(undefined)).toBe("");
  });
});

describe("formatTool — mesh / team / task / memory verb mapping", () => {
  const cases: Array<[string, string, string, ToolCategory]> = [
    ["ask", "Asked another agent", "detail", "mesh"],
    ["respond_ask", "Answered an ask", "detail", "mesh"],
    ["negotiate", "Negotiating with peer", "detail", "mesh"],
    ["respond_negotiate", "Negotiating with peer", "detail", "mesh"],
    ["report_blocker", "Reported a blocker", "detail", "mesh"],
    ["escalate_to_humans", "Escalated to humans", "detail", "mesh"],
    ["add_to_escalation", "Added to escalation", "detail", "mesh"],
    ["revise_task", "Revised a subordinate's task", "detail", "mesh"],
    ["create_subordinate_agent", "Spawned a specialist", "detail", "team"],
    ["create_task", "Minted a task", "detail", "team"],
    ["find_subordinates", "Surveyed the team", "detail", "team"],
    ["find_peers", "Surveyed the team", "detail", "team"],
    ["find_up", "Surveyed the team", "detail", "team"],
    ["get_agent_profile", "Read a peer's profile", "detail", "team"],
    ["check_work_status", "Checked work status", "detail", "task"],
    ["get_task", "Checked work status", "detail", "task"],
    ["list_work_products", "Checked work status", "detail", "task"],
    ["create_work_product", "Filed a work product", "detail", "task"],
    ["update_work_product", "Filed a work product", "detail", "task"],
    ["update_progress", "Updated progress", "detail", "task"],
    ["search_context", "Searched memory", "detail", "memory"],
    ["save_memory", "Saved a memory", "detail", "memory"],
    ["update_core_memory", "Updated core memory", "detail", "memory"],
  ];

  it.each(cases)("%s → %s (%s category)", (name, label, detail, category) => {
    const display = formatTool(name, detail);
    expect(display.label).toBe(label);
    expect(display.category).toBe(category);
    expect(display.detail).toBe(detail);
  });

  it("matches after stripping the mcp__ prefix", () => {
    expect(formatTool("mcp__beevibe__ask", "hi").label).toBe("Asked another agent");
  });
});

describe("formatTool — native Claude Code tools", () => {
  it("maps Read to the fs category", () => {
    const d = formatTool("Read", "src/main.ts");
    expect(d.label).toBe("Read");
    expect(d.category).toBe("fs");
  });

  it("distinguishes Write from Edit", () => {
    expect(formatTool("Write", "a.ts").label).toBe("Wrote file");
    expect(formatTool("Edit", "a.ts").label).toBe("Edited file");
    expect(formatTool("Write", "a.ts").category).toBe("fs");
  });

  it("maps Bash to the shell category", () => {
    const d = formatTool("Bash", "npm test");
    expect(d.label).toBe("Bash");
    expect(d.category).toBe("shell");
  });

  it("maps Glob and Grep to search", () => {
    expect(formatTool("Glob", "**/*.ts").label).toBe("Globbed paths");
    expect(formatTool("Grep", "TODO").label).toBe("Grepped");
    expect(formatTool("Glob", "x").category).toBe("search");
  });

  it("distinguishes WebFetch from WebSearch", () => {
    expect(formatTool("WebFetch", "https://x").label).toBe("Fetched URL");
    expect(formatTool("WebSearch", "query").label).toBe("Web search");
    expect(formatTool("WebFetch", "https://x").category).toBe("search");
  });

  it("renders ToolSearch off its raw (un-normalized) name", () => {
    const d = formatTool("ToolSearch", "select:Read,Edit");
    expect(d.label).toBe("Selected tools");
    expect(d.category).toBe("other");
  });
});

describe("formatTool — unknown tool fallback label", () => {
  it("humanizes snake_case into spaced words", () => {
    expect(formatTool("some_new_tool", "").label).toBe("some new tool");
  });

  it("splits camelCase boundaries", () => {
    expect(formatTool("someNewTool", "").label).toBe("some New Tool");
  });

  it("falls back to 'step' when the name is empty", () => {
    const d = formatTool("", "");
    expect(d.label).toBe("step");
    expect(d.category).toBe("other");
  });

  it("collapses to 'step' when only an mcp prefix remains", () => {
    // A pure prefix normalizes to "" and fallbackLabel re-strips the
    // prefix off the raw name too, so nothing survives → "step".
    expect(formatTool("mcp__beevibe__", "").label).toBe("step");
  });
});

describe("formatTool — detail cleaning", () => {
  it("strips mcp__ prefixes embedded in the detail", () => {
    expect(formatTool("Bash", "call mcp__beevibe__ask now").detail).toBe("call ask now");
  });

  it("rewrites 'select:' into 'selected ' and de-underscores the tail", () => {
    expect(formatTool("Bash", "select:Read_Only").detail).toBe("selected Read Only");
  });

  it("replaces concrete task ids with the literal 'task'", () => {
    expect(formatTool("Bash", "open task_abc123DEF").detail).toBe("open task");
  });

  it("normalizes comma spacing and collapses whitespace", () => {
    expect(formatTool("Bash", "a,b,c   d").detail).toBe("a, b, c d");
  });
});

describe("categoryAccent", () => {
  it("returns a distinct accent class per category", () => {
    const categories: ToolCategory[] = [
      "mesh",
      "team",
      "memory",
      "task",
      "fs",
      "shell",
      "search",
      "other",
    ];
    for (const c of categories) {
      expect(categoryAccent(c)).toMatch(/\S/);
    }
    expect(categoryAccent("mesh")).toContain("hier-team");
    expect(categoryAccent("memory")).toContain("status-running");
    expect(categoryAccent("task")).toContain("status-review");
    expect(categoryAccent("other")).toContain("muted-foreground");
  });
});
