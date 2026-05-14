---
name: beevibe-discover-repo
description: >
  Find a GitHub repo that can plausibly accomplish a goal. Read-only metadata
  work — no clone, install, or run. Returns a short ranked list. Pairs with
  beevibe-use-repo, which borrows the chosen repo in a sandbox.
---

# Discover Repo

You pick the candidate repo. You do not trust any of them — `use_repo` runs
the chosen one inside a sandbox, where the trust boundary actually lives.

```text
discover_repos(goal, hints?)
```

Run inside a sandbox: parsing READMEs and package manifests is hostile input.
You may hit GitHub + package registries + Beevibe's own success history.
Export only the candidate list back to the parent.

## Inputs

- `goal` — what the parent wants done, in plain language.
- optional `hints.preferred_language`, `hints.required_runtime` (`cli` /
  `library` / `service`), `hints.license_must_allow`,
  `hints.exclude_repos`, `hints.max_candidates` (default `5`),
  `hints.scope` (`team` or `org` for prior-success lookups).

If `goal` is missing, return an empty result with `reason: "no goal"`.

## How to pick

For each candidate, judge:

1. **Has the team used it before for a similar goal?** If yes, this almost
   always wins — prior success is the strongest signal we have. Surface the
   count.
2. **Will it work for an agent?** Prefer repos with a CLI or library API,
   structured I/O, a quickstart, no required API keys for first-use, no
   human-in-loop prompts, non-privileged dependencies. Stars are a spam
   filter, not a quality signal.
3. **Does the license permit the intended use?** Hard gate. Skip otherwise.
4. **Can it install cheaply?** Penalize required system packages, GPU,
   privileged container flags, postinstall scripts.

If no candidate clears the bar, return an empty list with a reason. Better
than guessing.

## Result

Return 3–5 candidates, highest fit first.

```json
{
  "goal": "extract tables from PDFs",
  "candidates": [
    {
      "repo_url": "https://github.com/jsvine/pdfplumber",
      "display_name": "pdfplumber",
      "short_description": "Pure-Python PDF text + table extraction with CLI and JSON output.",
      "fit": "high",
      "reason": "Clean CLI, MIT, examples directory, no system deps.",
      "license": "MIT",
      "estimated_setup_minutes": 5,
      "prior_team_uses": 0,
      "next": "use_repo"
    }
  ],
  "reason": null
}
```

`fit` is one of `high` / `medium` / `low` — a single qualitative judgement,
not a number. `next` is `use_repo` (good to try) or `inspect_first` (worth
trying but install is non-trivial) or `ask_human` (top candidate isn't
confident enough — surface the list).

Every successful `use_repo` run feeds back into `prior_team_uses` for future
discovery calls. That is the loop.
