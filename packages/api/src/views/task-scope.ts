/**
 * "Which tasks may this person see?" — one definition.
 *
 * Three queries answer that question today: the task list
 * (`tasks.ts:LIST_SQL`) and both task branches of the inbox
 * (`inbox.ts:LIST_SQL`, which UNIONs a `review` and a `blocked` arm).
 * Each spelled the same three-way ownership test out by hand.
 *
 * Copy-pasted visibility rules are the kind that drift quietly: a
 * fourth ownership path added to the list but not the inbox doesn't
 * fail anything, it just makes one surface show a task the other
 * hides — or, in the other direction, leaks one. There is no test that
 * would notice. Keeping the predicate in one place is the point; the
 * dedupe is a side effect.
 *
 * The rule itself: a person sees a task when they own the agent it is
 * assigned to, own the agent that created it, or created it themselves.
 * The last arm exists for completeness — agents create tasks via the
 * `create_task` MCP tool, which stamps `creator_type='agent'`, so in
 * practice almost every row matches on one of the first two.
 */

/**
 * The joins {@link taskOwnerScopeSql} reads, against a `task t`.
 *
 * Bundled with the predicate because it cannot be evaluated without
 * them — a query that takes the predicate must take these too. Callers
 * needing the creator's *person* name (for a `creator_label`) add
 * `LEFT JOIN person crt_p` themselves; the scope rule doesn't use it.
 */
export const TASK_ACTOR_JOINS = /* sql */ `LEFT JOIN agent asg   ON asg.id   = t.assignee_id
LEFT JOIN agent crt_a ON crt_a.id = t.creator_id  AND t.creator_type = 'agent'`;

/**
 * The ownership test, as a parenthesised boolean expression.
 *
 * `param` is the placeholder holding the caller's person id (`"$1"`,
 * `"$3"`, …) — it varies because the surrounding queries bind different
 * numbers of parameters before it. It is a literal from this package,
 * never caller input.
 *
 * Returns a self-contained `(... OR ... OR ...)` group, so an enclosing
 * `AND` can't rebind the precedence.
 */
export function taskOwnerScopeSql(param: string): string {
  return /* sql */ `(
    asg.owner_id = ${param}
    OR crt_a.owner_id = ${param}
    OR (t.creator_type = 'person' AND t.creator_id = ${param})
  )`;
}
