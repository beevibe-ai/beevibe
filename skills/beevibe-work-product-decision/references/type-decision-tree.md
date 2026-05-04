# Per-Type Decision Tree

How to decide create vs update for each `WorkProductType`. Default rule: call `list_work_products(task_id)` first; match on identity (URL / external id). The cases below resolve ambiguity.

## `pull_request`

The PR URL is the identity. PRs evolve through commits but stay one PR.

- Same URL exists in target task's work products → **update_work_product** (refresh summary mentioning what changed)
- New URL → **create_work_product** (rare; usually means you opened a NEW PR for the same task, which is unusual — consider whether the old one should be closed first)

Revision sessions: almost always update. The PR didn't change identity; you just pushed more commits.

## `branch` / `commit`

Less common as standalone work products (usually rolled up into a PR), but if used:

- Same `external_id` (commit SHA / branch name) → update
- New SHA / new branch → create (this is a new artifact)

## `document`

Documents (Google Docs, Notion pages, etc.) with stable URLs.

- Same URL → update (the document evolves; the URL doesn't)
- New URL → create (intentional v2, e.g., "Q3 plan" vs "Q4 plan")

When in doubt: docs almost always update. Creating a v2 with a new URL is a deliberate choice.

## `design`

Design files (Figma, Sketch, etc.).

- Same URL → update
- New URL → create

Same as documents.

## `analysis` / `report`

Per-session research outputs.

- **Default: create**. Each analysis/report is its own artifact, even if tackling the same topic.
- Exception: if the agent is iterating on the SAME report across revisions (e.g., reviewer asked for tweaks), update.

## `preview`

Snapshot of a build / deployment for review.

- **Default: create**. Each preview is a fresh build.
- Exception: if the preview URL is stable across builds (some CI systems do this), update.

## `artifact`

Generic catch-all for things that don't fit elsewhere — datasets, traces, etc.

- **Default: create**. Each artifact is its own.
- Exception: if the agent is replacing an artifact in-place (same external_id), update.

## When in doubt

Lean toward **update** when the deliverable has a stable identity (URL, commit SHA, doc id). Lean toward **create** when each session genuinely produces a fresh artifact.

The cost of getting it wrong:

- **Wrong update** (creating when you should have updated) → duplicate rows in review dashboard, harder to track current state
- **Wrong create** (updating when you should have created) → loss of the prior artifact's history (though `updated_at` is bumped); usually less bad

So: prefer update when uncertain, especially for code-related artifacts.
