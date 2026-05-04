---
name: beevibe-work-product-decision
description: >
  Decide whether to create, update, or skip a work-product record. Use whenever
  you finish meaningful work and are about to record a deliverable — PR, branch,
  commit, document, design, analysis, report, artifact, or preview. ALWAYS call
  list_work_products(task_id) first to check existing rows for this task. For
  PRs/branches/commits/docs with the same identity (URL match), call
  update_work_product to refresh — do NOT duplicate. For new identities (e.g.,
  a v2 doc with a fresh URL) or analyses/reports/previews (typically fresh per
  session), call create_work_product. Skip the call entirely if the session
  produced no recordable deliverable.
---

# Work Product Decision

## The problem this skill solves

Without this guidance, agents reflexively call `create_work_product` on every revision session, producing duplicate rows like "PR (v1)" and "PR (v2)" for the same PR. The human review dashboard then shows N rows for the same artifact — confusing and wasteful.

## The protocol

### Step 1: ALWAYS call list_work_products first

```
list_work_products(task_id)
```

Never reflexively `create_work_product`. The list tells you what's already recorded for this task.

### Step 2: Decide create / update / skip

Use the decision tree:

```
                            existing wp on this task?
                                     │
                  ┌──────────────────┴──────────────────┐
                  no                                    yes
                  │                                     │
                  ▼                                     ▼
            same kind of                       same identity?
            deliverable?                       (URL / id match)
                  │                                     │
        ┌─────────┴─────────┐                  ┌────────┴────────┐
        no                  yes                yes               no
        │                   │                  │                 │
        ▼                   ▼                  ▼                 ▼
      SKIP             create_              update_         create_
      (no              work_                work_           work_
      deliverable      product              product         product
      to record)                                            (intentional
                                                            new artifact
                                                            — see below)
```

### Step 3: Per-type heuristics

For nuance on "same identity" per artifact type, see `references/type-decision-tree.md`. Quick summary:

- **PR / branch / commit** → update if URL matches; nearly always update on revision sessions
- **Document / design** → update if URL matches (same Google Doc, content revised); create if intentional v2 with new URL
- **Analysis / report / preview / artifact** → usually create; these are typically fresh per session

## When to skip

Skip the call entirely if the session didn't produce a recordable deliverable. Examples:

- You did code review but didn't commit anything
- You answered a peer's `ask` (no PR, no doc)
- You read context and decided not to act
- You triaged but couldn't proceed (call `report_blocker` instead)

Don't create empty work-product rows just to mark "I did something." The session row itself is the audit trail for "an attempt was made."

## Updating

When you call `update_work_product(id, ...)`:

- Identity fields (`type`, `title`, `task_id`, `agent_id`) are immutable — they describe what the deliverable IS, and "this PR" doesn't change identity when its summary refreshes.
- `summary`, `url`, `provider`, `external_id`, `metadata` can change.
- `updated_at` bumps automatically — the review UI uses this to show freshness.

On revision sessions, mention what changed in the new `summary`:

> *"Revised per reviewer feedback: added error handling for the rate-limit path. PR: github.com/x/y/pull/42."*
