---
name: beevibe-team-task-creation
description: >
  Create a task and assign it to a subordinate correctly. Use whenever about
  to call create_task — covers picking the right assignee (via
  find_subordinates and get_agent_profile), title/description specificity,
  sub-task linkage via parent_task_id for auto-rollup, and the repo_url field
  that the assignee's beevibe-pre-task-setup skill needs for code work.
  Without enough context here, the assignee will either re-ask via
  report_blocker (slow) or guess wrong (wasteful). Spend 30 seconds writing
  a clear task and save the assignee's session.
---

# Task Creation

## Why this skill matters

The task you create is what the assignee sees in stdin. If it's vague, they'll either:

- Call `report_blocker` (slow round-trip)
- Guess and produce the wrong thing (wasteful retry cycle)

Spending 30 seconds writing a clear task saves 5+ minutes downstream.

## Steps

### 1. Pick the right assignee

```
find_subordinates()
```

Returns your direct reports. Inspect each — don't reflexively assign to the same agent every time:

- Match by specialty (look at `name`, `core_memory.persona`, prior work via `check_work_status`)
- Verify with `get_agent_profile(agent_id)` if you need more detail (role, hierarchy_level, capacity hints)

If no subordinate fits → don't create the task. Either:

- Hire / provision a new agent (out-of-band human action)
- Do the work yourself if it's small and in your wheelhouse
- `report_blocker` if the work is critical-path

### 2. Required arg shape

```
create_task(
  intent: <title>,             // concrete deliverable, NOT vague intent
  agent_id: <subordinate id>,
  description?: <longer body>,
  priority?: 'low'|'medium'|'high',
  parent_task_id?: <your current task>,
  repo_url?: <git URL for code tasks>,
)
```

### 3. Title = concrete deliverable

Bad: *"Improve the checkout flow"*
Good: *"Add accessibility audit to the checkout flow"*

The title should answer "what specific thing will be delivered?" — not "what general area will be worked on?"

### 4. Description = enough context to act

Include:

- Success criteria (how will the assignee know they're done?)
- Constraints (what they shouldn't change)
- Pointers to related context (parent task, prior work products, existing PRs)
- The "why" (what motivated this task)

Don't dump everything — but don't leave them to re-derive context they could've had.

### 5. `parent_task_id` for auto-rollup

If THIS task is a sub-task of YOUR current task, pass `parent_task_id`. Then:

- The platform tracks the parent-child relationship
- When all your spawned subtasks settle, the parent auto-completes (rollup)
- You can exit your session after spawning — see `beevibe-task-completion`'s leaf-vs-parent rule

If you don't pass `parent_task_id`, the new task is standalone (orphan from a hierarchy perspective). Use this for genuinely independent work, not as a default.

### 6. `repo_url` for code tasks (CRITICAL)

If the assignee will touch code, include `repo_url`. The assignee's `beevibe-pre-task-setup` skill clones / pulls / worktrees off this URL.

Without `repo_url`:

- The assignee's pre-task-setup falls back to parsing the description for repo context
- If still ambiguous, they `report_blocker` asking for the repo
- That's a wasted round-trip — pass the URL upfront

For multi-repo tasks, name the primary repo in `repo_url` and mention the others in the description.

For non-code tasks (research, drafting, design), omit `repo_url`.

## Example: clear task creation

```
find_subordinates()                       // returns [ic-alice, ic-bob, ...]
get_agent_profile(ic-alice.id)            // confirms alice handles a11y work

create_task(
  intent: "Add accessibility audit to the checkout flow",
  agent_id: ic-alice.id,
  description:
    "Audit the existing checkout flow for WCAG 2.1 AA compliance. "
    + "Focus areas: keyboard navigation, screen reader announcements, "
    + "color contrast on the payment step. "
    + "Deliverable: PR with fixes for any P0/P1 issues found, "
    + "+ a short report listing P2/P3 issues for follow-up. "
    + "Out of scope: the cart page (separate task).",
  priority: "medium",
  parent_task_id: <my current task id>,   // I'm rolling this up
  repo_url: "github.com/beevibe-ai/example-storefront",
)
```

## After creating

The task is `status='assigned'`. The executor picks it up within ≤30s and dispatches the assignee. You don't need to do anything else for THIS task — focus on your other work or exit if you have nothing else.

If you created multiple subtasks and ALL your work consists of orchestrating them, you're a parent task — see `beevibe-task-completion`'s leaf-vs-parent rule. Don't call `update_progress(done)` yourself; the rollup will fire when children settle.
