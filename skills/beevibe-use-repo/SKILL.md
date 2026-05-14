---
name: beevibe-use-repo
description: >
  Use an external GitHub repo as a temporary sandboxed tool to produce an
  artifact for the parent's goal. Repo dependencies never touch the user's
  host workspace. Pairs with beevibe-discover-repo, which picks the repo.
---

# Use Repo

You are a child agent in a fresh sandbox. Borrow the repo, produce a real
artifact, return it. Don't review the repo. The proof is that it helps you
do the work.

```text
use_repo(repo_url, goal, inputs?, limits?)
```

## Inputs

- `repo_url`, `goal` — required.
- optional `inputs` — files, URLs, fixtures, params the goal needs.
- optional `limits.wall_clock_minutes` (default `20`),
  `limits.max_install_attempts` (default `2`),
  `limits.disk_mb`,
  `limits.allow_network_after_clone` (default `false`),
  `capture_skill` — draft a reusable skill if the run works.

If `repo_url` or `goal` is missing, return `blocked`.

## Trust boundary

The sandbox runtime enforces:

- no host workspace mount; no user secrets unless explicitly granted
- network gated after the initial clone
- wall-clock, install-attempt, and disk budgets
- artifact-only export back to the parent

Installation runs untrusted code (`pip install` runs `setup.py`, etc.). The
sandbox contains the blast radius; your job is to observe and report, not to
defend against it.

## Protocol

1. **Clone** the repo into `./repo` and record the pinned commit.

2. **Read enough to use it** — README, manifests, examples, scripts.
   Don't audit; find the shortest path to the goal.

3. **Install** the least invasive way that works:
   - existing command → project-local venv/deps → container install →
     install script (only when docs demand it).
   - Capture logs. Stop at `max_install_attempts`. Stop early if the wall
     clock or disk is exhausted, or if the repo can't plausibly do the goal.

4. **Run it.** Save outputs under `artifacts/<short-slug>/`. Prefer
   machine-checkable outputs (files, JSON, structured stdout).

5. **Verify.** Run a small check (parse the output, list files, run
   `--help`, render a tiny fixture). Not a full test suite.

6. **Capture skill (optional).** If `capture_skill` is true and the run
   succeeded, draft `artifacts/skill/SKILL.md` with the install recipe,
   inputs, invocation, and known limits. Don't let this block the main
   result.

## Result

```json
{
  "status": "succeeded",
  "repo_url": "https://github.com/org/repo",
  "pinned_commit": "40-char-sha",
  "goal": "what the parent asked for",
  "artifact_paths": ["artifacts/example/output.json"],
  "summary": "what was produced",
  "verification": [{ "name": "artifact exists", "passed": true }],
  "limits_used": {
    "elapsed_minutes": 6,
    "install_attempts": 1,
    "network_after_clone_used": true
  },
  "blocked_reason": null,
  "generated_skill_path": "artifacts/skill/SKILL.md"
}
```

Statuses: `succeeded` · `partial` · `blocked` · `failed`. Use `blocked` for
budget / access / dependency / platform issues — the repo didn't get a fair
chance. Use `failed` when execution itself broke.

A failed run is still useful — return the classified reason instead of
nothing.
