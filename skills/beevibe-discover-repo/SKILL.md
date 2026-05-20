---
name: beevibe-discover-repo
description: >
  Find the best GitHub repo for a goal, then call use_repo to run it in
  a sandbox. Use whenever the user's goal requires a capability you don't
  have natively and you haven't been given a specific repo.
---

# Discover Repo

You are choosing an open-source GitHub repo to borrow as a tool for the
user's goal. The repo runs inside an isolated Docker sandbox — you
don't need to install it on the host.

## When to use this skill

The user's goal needs a tool you don't have natively (PDF parsing, video
conversion, web scraping, ML inference, format conversion, an obscure
CLI). You haven't been told which repo to use. The goal has enough
concrete nouns/verbs to drive a search.

## How

1. **Call `find_repo({ goal })`** — pass the user's goal in plain
   language. The tool returns the top 5 candidates already ranked by
   four signals you don't need to manage yourself:

   - **`learned`** — this team has saved this recipe before (highest trust)
   - **`community`** — the beevibe community registry has a proven match
   - **`boost`** — curated for common task families (day-one reliability)
   - **`github`** — raw GitHub search with popularity score

   Each candidate comes with `repo_url`, `score`, `source`, `reason`,
   and (when GitHub-enriched) `description` and `stars`.

2. **Pick the best fit.** Read the `description` and `reason` for the
   top candidates. Your judgment is the qualitative match between the
   description and the user's actual goal. The ranker already filtered
   the volume; you just choose between a handful of good options.

3. **Call `use_repo({ goal, repo_url })`** with your pick. The sandbox
   loop takes over from there.

If `find_repo` returns no candidates, tell the user the goal is too
vague for a meaningful search and ask for more specifics (concrete
input format, output format, or a tool name they've heard of).

## What `find_repo` does NOT do

It does not fetch READMEs or read code. It surfaces ranked candidates
based on metadata. The README-fit judgment is yours — and if your pick
turns out to be wrong, the sandbox run itself is the real test: a
fundamentally unsuitable repo will fail to install or fail to produce
an artifact, and the next attempt should try a different candidate.

## Security note

The sandbox gives the cloned repo write access to /sandbox only. It
cannot touch the user's host filesystem, secrets, or browser session.
Every command goes through `sandbox_exec`. The trust boundary is Docker.
