---
name: beevibe-task-completion
description: >
  How and when to terminate a beevibe agent task session. Use at session end
  for any leaf task — call update_progress(task_id, status, summary) to
  formalize the terminal state, then exit. Covers leaf vs parent distinction
  (parents auto-complete via children rollup — calling update_progress
  yourself short-circuits the rollup), summary writing for the human review
  dashboard, and avoidance of the "session exits without update_progress"
  retry path. Universal across tiers; team-tier agents have an extra
  leaf-vs-parent check (see references/leaf-vs-parent.md).
---

# Task Completion

## When to call update_progress

After all work is done AND any work products are recorded (see `beevibe-work-product-decision`):

```
update_progress(task_id, status, summary)
```

The `task_id` is the id from your intent's `<task id="..."/>` tag.

## Status semantics

- **`done`** — work succeeded; the deliverable is ready for human review. The platform's `review_policy` may rewrite this to `review` if a human reviewer is required for this agent.
- **`failed`** — task can't be completed. The `summary` MUST explain why. Don't use this for transient errors — retry first.
- **`blocked`** — only if you already called `report_blocker`. The blocker tool itself sets `task.status='blocked'`, so this is technically optional but makes your terminal intent explicit.

## Summary

1-3 sentences capturing **what was actually delivered**. Include:

- URLs (PR link, doc link)
- Work product ids (`wp_*`)
- File paths if relevant

The summary is the operator's first read of your output on the human review dashboard. Make it useful at a glance — don't just restate the task title.

Bad: *"Done."*
Bad: *"Implemented the feature as requested."*
Good: *"Added accessibility audit to checkout flow. PR: github.com/x/y/pull/42 (wp_abc123). Found 3 issues — 2 fixed, 1 needs design input (flagged in PR description)."*

## Exit

After `update_progress`, exit. No further work in this session.

The session ending without `update_progress` triggers a wasteful retry session 2s later — see "Why this matters" below.

## Why this matters

Without `update_progress`, the executor's M6.5 retry path fires 2 seconds after your session exits with a `<context type="nudge_completion">` nudge. Result: ONE task → TWO sessions, double the token usage, double the operator log noise. The nudge session usually just calls `update_progress` and exits, so the work itself isn't redone — but the cost is real.

This skill exists specifically to close that footgun. Don't be the agent that triggers it.

## Leaf vs parent (team-tier only)

If you have `create_task` in your tool surface, you might be a parent. The rule:

> Did you call `create_task(...)` during this session?

- **No** → leaf task. Default rule applies — call `update_progress` per above. Exit.
- **Yes** → parent task. **Do NOT call `update_progress(done)`** — children rollup automatically marks the parent done when all children settle. Calling it yourself short-circuits the rollup and produces inconsistent state.

See `references/leaf-vs-parent.md` for edge cases (mixed-outcome children, partial errors).

IC-tier agents don't have `create_task` — they're always leaf. Use the default rule.
