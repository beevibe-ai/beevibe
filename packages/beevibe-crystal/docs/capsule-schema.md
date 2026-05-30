# Beevibe Crystal capsule schema (v0.1)

A **capsule** is the unit Beevibe Crystal shares. It is not a chat
transcript - it is a frozen, queryable representation of an AI collaboration
session.

The MVP only imports Claude Code session files (`*.jsonl`), but the schema is
intentionally source-agnostic so Cursor, ChatGPT exports, etc. can be added
later as new importers without touching the viewer.

## Top-level

```json
{
  "version": "0.1.0",
  "id": "string",
  "source": "claude-code" | "chatgpt" | "claude-ai" | "manual",
  "publishedAt": "ISO-8601",
  "title": "string",
  "summary": "string",
  "metadata": { ... },
  "events": [ ... ],
  "context": { ... },
  "visibility": "public" | "unlisted" | "private"
}
```

## metadata

Derived stats. The crystal cover's visual parameters come from here.

```json
{
  "model": "claude-sonnet-4-5",
  "durationMs": 0,
  "messageCount": 0,
  "toolCallCount": 0,
  "fileChangeCount": 0,
  "abandonedCount": 0,
  "outcome": "resolved" | "abandoned" | "in-progress",
  "topics": ["debug", "refactor", ...]
}
```

## events (ordered timeline)

Each event has `type` and `ts`. Other fields depend on type.

- `message`     — `{ role: "user" | "assistant", content: ContentBlock[] }`
- `tool_use`    — `{ name, input, result, ok }`
- `file_change` — `{ path, before, after, diff }`
- `thinking`    — `{ content }` (only present if source preserved it)

The viewer renders events in order; importers are responsible for flattening
source-specific structures into this shape.

## Visitor chat — stance inheritance

When a visitor asks the capsule a question, the chat endpoint receives:

1. The full capsule (events + summary) as system context
2. The visitor's question

The model is instructed to answer **as a continuation of the publisher's
reasoning** — i.e. using the stance and conclusions that the session arrived
at, not as a neutral narrator. This is a v1 choice; the alternative ("neutral
narrator") is reserved as a future toggle once we see how publishers feel
about their capsule "speaking for them".

## Persistence

The server stores capsules on the filesystem at
`packages/beevibe-crystal/.capsules/<id>.json` (gitignored). The browser also caches a
copy in `localStorage` for instant loads. The viewer hydrates from
localStorage first, then falls back to `GET /api/capsules/:id` for capsules
that came from someone else's publish.

## Publishing surface

Two clients call `POST /api/capsules`:

1. The `/crystal:publish` skill — sends the raw `.jsonl` of the current
   Claude Code session (content-type `application/x-jsonl`).
2. The web drag-drop importer — sends a pre-parsed capsule
   (`{ "capsule": {...} }`).

Both paths hit the same parser and produce the same shape.

## What's NOT in v0.1

- No incremental updates (capsule is immutable; republish for v2)
- No crystal-to-crystal interaction
- No accounts / auth / team scoping
- No automated redaction (publisher is responsible for what they upload)
- No hosted deployment — server runs on the publisher's machine
