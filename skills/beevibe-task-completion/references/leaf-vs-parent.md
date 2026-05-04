# Leaf vs Parent Heuristic (team-tier only)

The default `beevibe-task-completion` rule is "call `update_progress(done|failed|blocked)` and exit." This file covers when that rule does NOT apply.

## The rule

Did you call `create_task(...)` during this session?

- **No** → leaf task. Default rule applies — call `update_progress` and exit.
- **Yes** → parent task. Do NOT call `update_progress(done)`.

## Why parents skip `update_progress(done)`

The platform has automatic parent rollup (`checkAndCompleteParent` in M3): when all children of a parent reach a terminal status, the parent is marked done. Calling `update_progress(done)` yourself BEFORE children settle creates inconsistent state — the parent is marked "done" while children are still in-flight.

## What parents SHOULD do

After spawning subordinate tasks via `create_task`, exit your session normally. The rollup fires automatically when the last child settles.

If you need to do additional work AFTER children settle (e.g., a final synthesis pass), the platform will re-dispatch you only when explicitly triggered (revision feedback, post-escalation resume). Don't try to stay alive waiting for children.

## Edge cases

### All my subordinates failed
The rollup leaves the parent in `in_progress` (no `done` because not all children done; not auto-failed either). At that point, the operator (or your own parent via `revise_task`) intervenes. You don't need to do anything — just exit.

### I produced an error BEFORE delegating
E.g., couldn't find a suitable subordinate, or rejected the input as malformed.

In this case there are no children to roll up. Call `update_progress('failed', "...")` with a summary explaining what went wrong — you've concluded the task can't be done. The default leaf rule applies.

### I delegated SOME work then need to finish more myself
You're a hybrid parent + leaf. The rollup logic only counts children — your own direct work doesn't count.

If your own work succeeded: skip `update_progress(done)`. The rollup will fire when children settle, and the parent is correctly marked done.

If your own work failed: this is a real edge case the platform doesn't handle gracefully. Call `report_blocker` upward instead — your parent agent (or operator) needs to make a decision about whether to abandon the parent task.

### I'm a parent but I want to mark the task `failed` proactively (children still running)
Don't. Either let children settle naturally, or call `report_blocker` if you've decided the whole approach won't work. `update_progress(failed)` on a parent with in-flight children is a bug-shaped action.
