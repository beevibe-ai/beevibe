# Beevibe Crystal

> The thinking, not the transcript.

Beevibe Crystal is a Beevibe project for turning AI work sessions into
shareable, queryable capsules. Publish a Claude Code session, send the link,
and visitors can ask questions that answer in the publisher's voice with the
session context behind it.

If this is useful, star the parent project:
<https://github.com/beevibe-ai/beevibe>

## Two Ways To Publish

### A. `/crystal:publish` (recommended)

Install the Claude Code plugin once:

```bash
claude plugin marketplace add beevibe-ai/claude-plugins
claude plugin install crystal@beevibe
```

If you previously added the old Beevibe marketplace from
`beevibe-ai/architecture-deep-research`, repoint it first:

```bash
claude plugin marketplace remove beevibe
claude plugin marketplace add beevibe-ai/claude-plugins
claude plugin install crystal@beevibe
```

Inside any Claude Code session, run:

```text
/crystal:publish
```

The installed plugin command at
[`plugin/commands/publish.md`](./plugin/commands/publish.md) finds the active
session's `.jsonl`, POSTs it to your local Crystal server, and prints the
share URL.

### B. Drag And Drop

Open <http://localhost:5273>, drop a `.jsonl` file, and Crystal creates the
same capsule. This is useful for republishing an archived session or importing
a non-Claude-Code source later.

## Run Locally

From the Beevibe repo root:

```bash
pnpm install
export ANTHROPIC_API_KEY=sk-ant-...   # required for visitor chat
pnpm crystal:dev
```

Or run the two processes separately:

```bash
pnpm crystal:server   # API on :5274
pnpm crystal:viewer   # web on :5273
```

Then either drop a file on `localhost:5273`, or run `/crystal:publish` in a
Claude Code session.

## Env Vars

| var | default | meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | optional for publish, required for chat | passed to Anthropic SDK |
| `CRYSTAL_BALL_MODEL` | `claude-sonnet-4-5` | model used for visitor chat |
| `CRYSTAL_BALL_MAX_TOKENS` | `1024` | per-reply token cap |
| `CRYSTAL_VIEWER_URL` | `http://localhost:5273` | what the server bakes into share URLs |
| `CRYSTAL_VIEWER_PORT` | `5273` | Vite viewer port |
| `CRYSTAL_BALL_SERVER_URL` | `http://127.0.0.1:5274` | where `/crystal:publish` POSTs |
| `PORT` | `5274` | server port |

## What's In v0

- **Claude Code plugin** - `/crystal:publish` captures the current Claude Code
  session and publishes it.
- **Server** - `server.mjs` exposes:
  - `POST /api/capsules` - parse and store capsule
  - `GET /api/capsules/:id` - fetch capsule
  - `POST /api/chat` - visitor chat with stance inheritance
- **Web viewer** - Vite + React + react-three-fiber:
  - 3D crystal cover derived from session stats.
  - Drag-drop importer.
  - Chat surface for visitors.
  - Mind map navigation for the public surface.
- **Storage** - local filesystem at `packages/beevibe-crystal/.capsules/<id>.json`.
  No auth, accounts, or expiration in v0.

## What's Deliberately Not Here

- No auto-redaction. Publisher is responsible for what's in the session.
- No crystal-to-crystal interaction.
- No accounts, auth, or team scoping.
- No incremental updates. Capsules are immutable; republish for v2.
- No hosted deployment story yet. The server runs on your laptop.

## Architecture Decisions

See [`docs/capsule-schema.md`](./docs/capsule-schema.md) for the durable
schema. Importers (`src/lib/parser.js`) and visitor chat both consume this
shape, so future Cursor, ChatGPT, and Aider importers can plug in without
touching the viewer or chat.
