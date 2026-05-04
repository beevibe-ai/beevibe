---
name: beevibe-memory-management
description: >
  Self-managed memory updates — when and how to write to core memory vs
  archival memory. Use throughout the session, not at one specific trigger.
  Watch for moments where you learn something durable (decision rationales,
  gotchas, surprising patterns, role/persona shifts). Use update_core_memory
  for stable persona/domain/constraint changes that should appear in every
  future session's briefing. Use save_memory for one-shot facts retrievable
  via vector search. Use search_context when the briefing's top-k didn't
  cover a topic you now need. Default rule when in doubt: save_memory —
  archival is forgiving; core memory is space-constrained.
---

# Memory Management

You have two memory layers. The system gives you tools to write to both, but YOU decide when and what.

## Two layers

### Core memory (in-context, small)

Editable via `update_core_memory(block_name, operation, content, old_content?)`. Blocks appear in every future session's briefing as part of your system prompt. Common blocks:

- `persona` — who you are, your role
- `domain` — the technical domain you operate in
- `constraints` — hard rules to follow
- `learnings` — durable patterns from prior work

Treat as expensive real estate — every byte appears in every session prompt. Use sparingly.

### Archival memory (vector-indexed, unbounded)

Editable via `save_memory(content, fact_type)`. Retrievable via:

- Session-start briefing's top-k vector hits (M9.4 puts this in your user prompt prefix)
- `search_context(query)` mid-session for on-demand recall

Cheap — default home for facts.

## When to update core memory

- **Stable persona shifts**: "I now also handle Y" → `update_core_memory('persona', 'append', '...')`
- **Long-term constraint changes**: "team has decided to deprecate framework X" → append to `constraints`
- **Durable learnings that change future behavior**: "for project Y, we always use approach Z" → append to `learnings`

Use `replace` (with `old_content` arg specifying the exact passage to swap) to revise outdated content. Use `append` for additions.

Don't put per-session results in core memory. Don't put "I just learned X about this one task" — that's archival.

## When to save_memory (archival)

One fact per call. `fact_type ∈ {belief, pattern, gotcha, preference, decision}`:

- **`decision`** — "we chose X over Y because Z" (rationale that shouldn't get lost)
- **`gotcha`** — "watch out for X — it costs Y" (negative pattern worth remembering)
- **`pattern`** — "when we see X, prefer Y approach" (positive pattern)
- **`preference`** — "user prefers concise summaries over walls of text"
- **`belief`** — broader claims, defaults

Examples that go to archival:

- Resolutions to blockers (after `report_blocker → revise_task`): `save_memory("blocker about X was resolved by Y approach", "decision")`
- Surprising findings: `save_memory("the foo API rate-limits silently at 100/min — not documented", "gotcha")`
- Successful approaches: `save_memory("for postgres migrations on this repo, always use the migrate-up-down pattern", "pattern")`

## When to search_context

The session-start briefing has top-k facts (limited; ~10 hits by default). Use `search_context(query)` mid-session when:

- A specific topic surfaces and isn't in your briefing
- You need a niche fact you might have written months ago
- Context has expanded beyond the briefing's initial scope

Cheap to call. Don't over-use — your briefing's archival memory should cover most cases.

## End-of-task reflection

Before calling `update_progress`, ask: *"Did I learn anything in this session worth remembering?"*

If yes, write it now — your next session won't have your conversation history but WILL have your memory.

Examples:

- Resolved a blocker the parent hadn't anticipated → `save_memory("...", "decision")`
- Discovered a non-obvious gotcha → `save_memory("...", "gotcha")`
- Made a stable framing change ("I'm now the auth specialist for this domain") → `update_core_memory('persona', 'append', '...')`

## Default rule when in doubt

Use `save_memory`. Archival is forgiving — too many facts isn't a problem (vector search surfaces the relevant ones). Core memory is space-constrained — every block appears in every future session.

If you can't decide whether something is "stable enough" for core memory, it's probably not. Put it in archival; if it keeps surfacing, promote to core memory later.
