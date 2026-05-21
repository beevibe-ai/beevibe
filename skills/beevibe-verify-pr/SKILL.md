---
name: beevibe-verify-pr
description: >
  CI verification before marking a PR-bearing task done. Use BEFORE
  calling `mcp__beevibe__update_progress(done)` on any session whose
  deliverable is a pull request — including the first dispatch (you
  opened the PR with `gh pr create`) and any revision dispatch (you
  pushed new commits to an existing PR). Watches the PR's required
  GitHub checks with a 10-minute timeout and decides next-step based on
  the result. A green local build is not enough — the PR must pass the
  same CI gate a human reviewer would check before merging. Do NOT use
  for tasks that produce a `document`, `analysis`, `report`, `design`,
  `artifact`, or `preview` work_product (those don't have CI). Do NOT
  use for chat sessions. Use only when running as a beevibe agent.
---

# Verify PR CI

## When this fires

Any task session that ends with the agent having opened or pushed to a pull request. You are about to call `mcp__beevibe__update_progress(done)`. STOP. Verify CI first.

The agent's natural exit ramp is "I pushed the PR, I'll mark done." That's wrong if CI is red or still pending — the PR can't merge, the task isn't actually delivered, and the human reviewer will bounce it right back. Run this skill so the green/red call is settled before you exit the session.

## When this does NOT fire

- The deliverable isn't a PR (`document` / `analysis` / `report` / `design` / `artifact` / `preview` work_product types). CI doesn't apply.
- You're in a chat session. The skill is for tracked task sessions only.
- The task is `failed` or being reported via `update_progress(failed)`. CI doesn't gate failure reporting; just record the work and exit.
- You're calling `report_blocker` (not `update_progress(done)`). The PR isn't your blocker; the upstream dependency is.

## The protocol

### 1. Identify the PR URL

You already have it — it's the work product you just recorded with `create_work_product(type='pull_request', url='...')`. Or pull it from the most recent push output if you haven't recorded the work_product yet (record it before verifying — the human reviewer needs it visible regardless of CI outcome).

If you can't find a PR URL, you didn't actually open a PR; skip this skill and reassess what you delivered.

### 2. Watch CI

```bash
timeout 600 gh pr checks "$PR_URL" --required --watch
EC=$?
```

`--required` filters to checks that are gating per the repo's branch protection rules; advisory/optional checks are skipped. `--watch` polls every 10 seconds until checks resolve. `timeout 600` caps the wait at 10 minutes so you don't sit indefinitely if a runner stalls.

### 3. Branch on the exit code

| `$EC` | Meaning | Next step |
|---|---|---|
| `0` | All required checks passed | Proceed to `update_progress(done)` |
| `1` | One or more required checks failed | See **3a** below |
| `124` | `timeout` fired — checks still pending after 10m | See **3b** below |
| other | Unexpected (e.g. `gh` CLI error, no PR found, auth issue) | Investigate; don't paper over with a retry loop |

### 3a. CI failure path

Run `gh pr checks "$PR_URL"` (no `--watch`) for the full table — it shows you which check failed and a URL to the run log. Then:

```bash
# For a failing GitHub Actions check, the run id is in the URL:
gh run view <run-id> --log-failed
```

That dumps the failing-step log. Read it, identify the cause, push a fix to the same branch (the PR auto-updates), and re-run this skill from step 2. CI re-fires automatically on push.

If the failure is in a check you don't control (vendor service, env config, flaky), don't try to mask it — `report_blocker(task_id, "<check name> failing: <one-line reason>")` and let a human resolve.

### 3b. Timeout path

Some real failure modes look like this — a runner died mid-job, the GH Actions queue is backed up, or your repo's CI is genuinely 30-minute-class. Don't loop the `--watch` indefinitely.

```bash
# One more no-watch check — maybe a check resolved between the timeout
# and your decision:
gh pr checks "$PR_URL"
```

If the still-pending check is structurally slow (your repo CI takes 20+ minutes routinely), update_progress(done) is still wrong — the human shouldn't approve a task whose CI didn't finish in your session window. Better to:

```text
report_blocker(task_id, "CI still pending after 10m wait — required check '<name>' has not started/finished. PR url: <url>")
```

The human or parent agent picks up the blocker, waits for CI on their schedule, and revises or approves once CI lands. Your session exits cleanly without lying about completion status.

### 4. Only on a clean green: update_progress(done)

```text
mcp__beevibe__update_progress(
  task_id=<task_id>,
  status="done",
  summary="<short description + PR url + 'CI passed (N required checks)'>"
)
```

Including "CI passed" in the summary is load-bearing — it signals to the human reviewer that the green light has already been verified, so the review is purely about substance.

## Common pitfalls

- **Don't `--watch` without `--required`.** Optional/advisory checks (Dependabot, codecov, etc.) may never resolve and will pin you to the 10-minute timeout for no reason.
- **Don't suppress check failures with `|| true` or similar.** The skill's whole point is to gate on the exit code; defeating it produces a `done` task with red CI, which is exactly the bug this exists to prevent.
- **Don't push "fix CI" commits without understanding the failure.** `gh run view --log-failed` first, diagnose, then fix. Blind retries waste CI minutes and risk masking a real regression.
- **Don't recompute success locally** ("tests passed on my machine"). The PR is what gets merged; the PR's CI is the only definition of success that matters.

## Why this exists

Pre-skill, agents marked tasks `done` immediately after `gh pr create`. CI ran asynchronously, sometimes failed, and the PR sat unmergeable while beevibe insisted the task was done. Human reviewers had to manually notice and bounce. This skill closes the gap: the agent's session doesn't end on a lie.
