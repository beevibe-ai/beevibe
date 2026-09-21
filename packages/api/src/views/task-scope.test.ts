/**
 * The owner-scope predicate decides which tasks a person can see, on
 * every surface that lists tasks. It is a string, so nothing else in
 * the build would notice an arm going missing — these tests are the
 * check.
 */
import { describe, expect, it } from "vitest";
import { TASK_ACTOR_JOINS, taskOwnerScopeSql } from "./task-scope.js";

const flat = (sql: string): string => sql.replace(/\s+/g, " ").trim();

describe("taskOwnerScopeSql", () => {
  it("grants access via assignee-agent, creator-agent, or self-created", () => {
    expect(flat(taskOwnerScopeSql("$1"))).toBe(
      "( asg.owner_id = $1 OR crt_a.owner_id = $1 OR (t.creator_type = 'person' AND t.creator_id = $1) )",
    );
  });

  it("binds whichever placeholder the calling query has spare", () => {
    // The list query binds status and assignee first, so the person id
    // lands on $3 there and on $1 in the inbox.
    const third = taskOwnerScopeSql("$3");
    expect(third).toContain("asg.owner_id = $3");
    expect(third).not.toContain("$1");
  });

  it("wraps itself so an enclosing AND can't rebind the OR chain", () => {
    // `x AND a OR b` parses as `(x AND a) OR b` — which would hand every
    // task in the system to anyone matching the last arm. The outer
    // parens are load-bearing, not cosmetic.
    const sql = flat(taskOwnerScopeSql("$1"));
    expect(sql.startsWith("(")).toBe(true);
    expect(sql.endsWith(")")).toBe(true);
  });

  it("only reads aliases TASK_ACTOR_JOINS defines", () => {
    const aliases = flat(taskOwnerScopeSql("$1"))
      .match(/\b([a-z_]+)\.\w+/g)!
      .map((ref) => ref.split(".")[0]!);
    for (const alias of new Set(aliases)) {
      // `t` is the task table the caller supplies; the rest must be joined.
      if (alias === "t") continue;
      expect(flat(TASK_ACTOR_JOINS)).toContain(`agent ${alias} `);
    }
  });
});
