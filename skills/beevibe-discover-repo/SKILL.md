---
name: beevibe-discover-repo
description: >
  Find the best GitHub repo for a goal, then call use_repo to run it in
  a sandbox. Use whenever the user's goal requires a capability you don't
  have natively and you haven't been given a specific repo. Returns a ranked
  list of candidates with one-line fit descriptions, or fires use_repo
  directly when confident.
---

# Discover Repo

You are choosing an open-source GitHub repo to borrow as a tool for the user's goal. The repo will run inside an isolated Docker sandbox — you don't need to install it on the host.

## When to use this skill

- The user's goal requires a tool or library you don't have natively (PDF parsing, video conversion, web scraping, ML inference, file format conversion, CLI tools, etc.)
- You haven't been told which repo to use
- The goal is concrete enough to yield a meaningful search query

## Ranking algorithm (follow this order)

**Tier 1 — Community registry** (highest trust; real outcomes from other instances):
Fetch `https://raw.githubusercontent.com/beevibe-ai/beevibe-capabilities/main/registry.json`. Parse `skills[]`. If any entry's `goal_pattern` overlaps with the user's goal by ≥ 2 significant words, include it with a +30 boost. Use the entry's `repo_url` and `invocation` in your recommendation.

**Tier 2 — Local learned skills** (your instance's own history):
Check if the Beevibe instance has any saved skills matching this goal — if the `beevibe-use-repo` skill mentions reusing a saved skill, check if there is already a matching goal pattern. Add +50 for matches.

**Tier 3 — Curated boost list** (day-one reliability):
The boost list is embedded in this skill's directory at `boost-list.json`. Parse it and apply +20 to any entry whose `goal_keywords` overlap with the user's goal. Known-good repos for common task families.

**Tier 4 — GitHub search** (the open-source ocean):
Search GitHub for repos matching the goal. Add +0 (raw score from GitHub stars + recency).

## GitHub search (Tier 4)

Use WebFetch to hit the GitHub search API. Construct a query from the core nouns/verbs in the user's goal:

```
GET https://api.github.com/search/repositories?q=<keywords>&sort=stars&per_page=10
```

Add an auth header if `GITHUB_TOKEN` env var is set (higher rate limit — 5000/hr vs 60/hr):
```
Authorization: token <GITHUB_TOKEN>
```

Parse `items[]`. For each result, fetch its README briefly (`GET https://raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md`, first 3000 chars) and check for keyword overlap with the user's goal. Discard repos whose README doesn't mention any of the goal's core terms.

## Rate limits

Without a token: 60 API calls/hr per IP. That's fine for one-agent dev setups. For shared instances or active teams, set `GITHUB_TOKEN` in the daemon's environment to use the 5000/hr authenticated rate.

## Produce candidates

Rank the remaining candidates. Take the top 3. For each, write:
- Repo URL
- One sentence: what the repo does + why it fits this goal
- Estimated fit: Excellent / Good / Uncertain

Example output:
```
1. https://github.com/jsvine/pdfplumber — extracts tables and text from PDFs using computer vision; built exactly for this use case. Fit: Excellent (curated)
2. https://github.com/camelot-dev/camelot — similar scope, lattice-mode for bordered tables. Fit: Good
3. https://github.com/pymupdf/PyMuPDF — general-purpose PDF library; covers tables with more effort. Fit: Uncertain
```

## Fire use_repo

If you have one Excellent-fit candidate, call `use_repo` immediately without asking:

```
use_repo({
  goal: "<user's original goal>",
  repo_url: "<chosen repo url>"
})
```

If the best fit is Good or Uncertain, present the candidates and ask which to try. If none exceed a confidence threshold (< 2 keyword overlaps and no README match), say so and ask the user for more specifics.

## Security note

The sandbox gives the cloned repo write access to /sandbox only. It cannot touch the user's host filesystem, secrets, or browser session. Every command goes through sandbox_exec. The trust boundary is Docker.
