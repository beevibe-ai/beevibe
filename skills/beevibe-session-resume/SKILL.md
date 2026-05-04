---
name: beevibe-session-resume
description: >
  Handling review-cycle revision when a human reviewer has requested changes.
  Use when your session resumes with `<context type="revision" source="human">`
  in the intent — you have the full prior transcript via --resume and the
  human's feedback in the context block. Verify the prior worktree still
  exists, address the specific feedback (don't redo unrelated work), then
  complete via update_progress. Do NOT use for parent-agent unblocks (they
  have a different framing — see beevibe-post-blocker-revision).
---

# Session Resume — Review-Cycle Revision

## When this fires

Your session resumes with this in the intent:

```
<context type="revision" source="human">
A human reviewer requested changes:
<their feedback>

Address the feedback and re-submit via update_progress.
</context>
<task id="..."/>
```

## You have the full prior session

The CLI was spawned with `--resume <cli_session_id>`, so your conversation history from the prior pass is intact. You see your own previous work, your previous tool calls, and where you left off.

## Steps

### 1. Verify the worktree still exists

```bash
ls ~/.beevibe/workspaces/<your_agent_id>/<repo_name>-<task_id_short>/
```

- **Exists** → `cd` into it. State is preserved (uncommitted changes, partial work).
- **Missing** (rare): re-create per `beevibe-pre-task-setup`. The reviewer's feedback may not need the original code state to address.

### 2. Read the human's feedback carefully

The feedback is the SPECIFIC thing they want changed. Common shapes:

- "Add error handling for X"
- "The summary is unclear about Y"
- "This breaks invariant Z"

Don't redo work that wasn't flagged. The reviewer accepted everything else.

### 3. Address the feedback

Make the targeted changes. Update the existing PR / branch (don't open a new one — see `beevibe-work-product-decision` for the update vs create call).

### 4. Update the work product

Call `update_work_product(id, summary, ...)` to refresh the deliverable's summary explicitly mentioning what changed in this revision. Don't `create_work_product` — that produces a duplicate row.

### 5. Complete

`update_progress(task_id, 'done', "Revised: <what changed>. PR: <url>.")` — explicit revision summary helps the reviewer see the diff vs the prior pass.

Then exit. See `beevibe-task-completion`.

## Don't confuse this with parent-agent unblocks

The parent-agent revision flow (`<context type="revision" source="parent_agent" from="blocked">`) is structurally similar but semantically different — your parent is unblocking you, not reviewing your output. Use `beevibe-post-blocker-revision` for that case.
