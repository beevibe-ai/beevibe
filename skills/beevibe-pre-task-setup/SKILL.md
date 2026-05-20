---
name: beevibe-pre-task-setup
description: >
  Cold-start git workspace setup for a fresh beevibe task. Use at the start
  of a session whose intent has a `<task>` block but NO `<context
  type="revision">` or `<context type="post_escalation">` block. Clones the
  repo on first use; on every subsequent task refreshes the default branch
  and starts a per-task branch in place in the same clone. Falls back to a
  worktree only when a sibling session is already using the clone. Do NOT
  use on a resumed session.
---

# Pre-Task Setup

## When this fires

Every session that starts with a `<task id="..."/>` intent block. The session lifecycle (per the `beevibe` umbrella) requires you to be on a fresh task branch in the repo before doing any work.

## The protocol

### 1. Find the repo URL

Check for `repo_url` on the task. Fetch the task with `get_task(task_id)` if you don't already have it. The `repo_url` field tells you where to clone.

If `task.repo_url` is null:

- Parse the task description for git context (URLs, branch hints, "the foo repo")
- If still ambiguous, call `report_blocker(task_id, "Cannot determine repo for this task")` — the parent agent or operator will clarify

### 2. Check for existing clone

Your cwd is the workspace root (`~/.beevibe/workspaces/<your_agent_id>/`). The clone lives at `<repo_name>/`:

```bash
ls <repo_name>/.git/HEAD 2>/dev/null && echo "EXISTS" || echo "MISSING"
```

### 3. Clone or refresh, then branch in place

`<task_id_short>` = first ~8 chars of `task.id`. Branch name `agent/<task_id_short>` is what shows in `git branch -a` and on any PR.

```bash
# Clone if missing.
[ -d <repo_name>/.git ] || git clone <task.repo_url>
cd <repo_name>

# Refresh the default branch and start the task branch in place.
git fetch origin
if git checkout <default_branch> 2>/dev/null && git pull --ff-only; then
  # Clone is idle — branch off in place, no extra dir.
  git checkout -b agent/<task_id_short> 2>/dev/null || git checkout agent/<task_id_short>
else
  # Couldn't claim the clone (a sibling task session has uncommitted
  # work or is on a non-default branch). Fall back to an isolated
  # worktree for this task only.
  git worktree add ./../<repo_name>-<task_id_short> -b agent/<task_id_short>
  cd ./../<repo_name>-<task_id_short>
fi
```

### 4. Now do the work

You're on `agent/<task_id_short>` either in the shared clone or (in the rare concurrency case) in your own worktree. Make changes, commit, push the branch, open a PR — all from your current directory.

When you're done, leave the branch alone. The next task will branch off the default again. Old `agent/<...>` branches stay locally and on origin for history; they don't fork the working tree.

## Resumed sessions

`<context type="revision">` / `<context type="post_escalation">` spawns use `--resume` — your prior turn's `cd` and commits are in your conversation history, so don't re-clone or re-branch.

Edge case: if you branched in place (no worktree fallback) and a different task ran between turns, the shared clone may now be on a different branch. Restore yours first:

```bash
cd <repo_name>
git checkout agent/<your_task_id_short>
```

If your prior turn fell back to a worktree (`<repo>-<your_task_id_short>/`), it's still there — cd into it as before.

## Non-code tasks

If the task is research/drafting/etc. with no `repo_url`, this skill mostly doesn't apply. You can work directly in your workspace dir without cloning. When you produce a deliverable, follow the deliverable-handling rule in your `<beevibe_lifecycle>` reminder (call `list_work_products(task_id)` first to dedupe, then `create_work_product` or `update_work_product`).
