# Beevibe Crystal

> The thinking, not the transcript.

Beevibe Crystal is a Beevibe project for turning AI work sessions into
shareable, queryable capsules. Publish a Claude Code session, send the link,
and visitors can ask questions that answer in the publisher's voice with the
session context behind it.

If this is useful, star the parent project:
<https://github.com/beevibe-ai/beevibe>

## Quick Start

Paste your Anthropic API key once (in your terminal — never in a Claude chat,
since Crystal publishes the session), then start a public tunnel:

```bash
pnpm install
pnpm crystal:setup    # prompts for your key → ~/.beevibe/crystal/config.json (0600)
pnpm crystal:serve    # server + viewer behind a Cloudflare quick tunnel → public URL
```

`crystal:serve` prints a `https://*.trycloudflare.com` URL anyone can open. It's
ephemeral — the URL lives only while the process runs. Then run `/crystal:publish`
in a Claude Code session and the capsule link uses that public URL.

Local only (no tunnel): `pnpm crystal:dev` — viewer on <http://localhost:5273>,
capsules stored under `packages/beevibe-crystal/.capsules`. Check key status any
time with `pnpm crystal:doctor`.

## Publish From Claude Code

Crystal still works like a Claude Code plugin. The plugin source lives in this
package at [`plugin/`](./plugin), while real users install it from the small
Beevibe plugin marketplace repo so the install command stays clean.

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

## Publish By Drag And Drop

Open <http://localhost:5273>, drop a `.jsonl` file, and Crystal creates the
same capsule. This is useful for republishing an archived session or importing
a non-Claude-Code source later.

You can also run the two local processes separately:

```bash
pnpm crystal:server   # API on :5274
pnpm crystal:viewer   # web on :5273
```

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
