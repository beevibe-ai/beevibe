---
name: beevibe-pre-task-setup
description: >
  Cold-start git workspace setup for a fresh beevibe task. Use at the start
  of a session whose intent has a `<task>` block but NO `<context
  type="revision">` or `<context type="post_escalation">` block — i.e. the
  first dispatch of this task. Checks for an existing repo clone, pulls
  the base branch if present (clone if missing), and creates a fresh
  worktree per task on a dedicated branch. Do NOT use on a resumed session
  — the executor passes `--resume` to Claude Code on revisions, so your
  prior turn's `cd` and worktree state are already in your conversation
  history; just continue. Do NOT work directly in the base clone — that
  stays on the default branch for easy pulls and is shared across tasks.
  Use only when running as a beevibe agent.
---

# Pre-Task Setup

## When this fires

Every session that starts with a `<task id="..."/>` intent block. The session lifecycle (per the `beevibe` umbrella) requires you to set up your worktree before doing any work.

## The protocol

### 1. Find the repo URL

Check for `repo_url` on the task. Fetch the task with `get_task(task_id)` if you don't already have it. The `repo_url` field tells you where to clone.

If `task.repo_url` is null:

- Parse the task description for git context (URLs, branch hints, "the foo repo")
- If still ambiguous, call `report_blocker(task_id, "Cannot determine repo for this task")` — the parent agent or operator will clarify

### 2. Check for existing clone

Your cwd is the workspace root (`~/.beevibe/workspaces/<your_agent_id>/`). The base clone lives at `<repo_name>/`:

```bash
ls <repo_name>/.git/HEAD 2>/dev/null && echo "EXISTS" || echo "MISSING"
```

### 3. Clone or pull

- **If missing**: `git clone <task.repo_url>`
- **If present**: `cd <repo_name> && git fetch && git pull origin <default_branch>` to refresh the base

### 4. Create a fresh worktree

Always create a NEW worktree per task — never work in the base clone:

```bash
cd <repo_name>
git worktree add ./../<repo_name>-<task_id_short> -b agent/<task_id_short>
cd ./../<repo_name>-<task_id_short>
```

`<task_id_short>` is the first ~8 chars of `task.id`. The branch name `agent/<task_id_short>` makes it obvious in `git branch -a` who created the branch.

### 5. Now do the work

You're now in a clean per-task worktree. Make changes, commit them, push the branch, open a PR — all inside this directory.

## Why a separate worktree

- **Concurrent tasks**: each task gets its own worktree, so `max_task_sessions > 1` works without contention
- **Clean base**: the base clone stays on the default branch for easy pulls
- **Easy reset**: if something goes wrong, just delete the worktree and re-create

## Resumed sessions are NOT this skill

If your spawn intent contains `<context type="revision">` or `<context type="post_escalation">`, the executor used `--resume` to spawn you, so your prior turn's `cd <worktree>` and tool calls are already in your conversation history. Don't re-clone, don't re-worktree, don't re-invoke this skill — just continue from where you left off.

## Non-code tasks

If the task is research/drafting/etc. with no `repo_url`, this skill mostly doesn't apply. You can work directly in your workspace dir without a worktree. When you produce a deliverable, follow the deliverable-handling rule in your `<beevibe_lifecycle>` reminder (call `list_work_products(task_id)` first to dedupe, then `create_work_product` or `update_work_product`).
