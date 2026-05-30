---
description: Publish the current Claude Code session as a Beevibe Crystal capsule - a queryable snapshot others can ask questions about. Use when the user says "share this session", "send this to my cofounder", "publish this as a crystal", or `/crystal publish`. The output is a share URL.
---

# /crystal:publish - turn this session into a capsule

When the user invokes `/crystal:publish` (or asks any of the trigger phrases above), do the following. Do **not** ask follow-up questions first — go straight to step 1. Capsules are immutable; if the user wants a different snapshot they re-publish.

## Step 0 — Pre-flight (one-line bash, no narration)

Confirm the server is reachable. The default is local; override with `CRYSTAL_BALL_SERVER_URL`.

```bash
CRYSTAL_SERVER="${CRYSTAL_BALL_SERVER_URL:-http://127.0.0.1:5274}"
curl -fsS --max-time 2 "$CRYSTAL_SERVER/api/health" >/dev/null \
  || { echo "Beevibe Crystal server not reachable at $CRYSTAL_SERVER. Start it with 'pnpm crystal:server' in the Beevibe repo, or set CRYSTAL_BALL_SERVER_URL to a hosted instance."; exit 1; }
```

If the server isn't up, surface the message verbatim to the user and stop. Don't try to auto-start it — they may want to publish to a hosted instance.

## Step 1 — Find the current session file

Claude Code stores session transcripts at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where the encoded cwd replaces `/` with `-`. The currently-active session is the most recently modified `.jsonl` in that directory.

```bash
SESSION_DIR="$HOME/.claude/projects/$(pwd | sed 's|/|-|g')"
SESSION_FILE="$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1)"
[ -n "$SESSION_FILE" ] || { echo "No session file found under $SESSION_DIR. Are you running this inside a Claude Code session?"; exit 1; }
echo "Publishing: $SESSION_FILE"
```

If `SESSION_FILE` is empty, surface the message and stop. Common cause: this skill was invoked from a host other than Claude Code.

## Step 2 — POST the session to the server

The server parses the `.jsonl`, derives metadata, stores the capsule, and returns `{ id, url, capsule }`.

```bash
RESPONSE="$(curl -fsS -X POST "$CRYSTAL_SERVER/api/capsules" \
  -H 'content-type: application/x-jsonl' \
  --data-binary "@$SESSION_FILE")"
echo "$RESPONSE"
```

If the POST fails (HTTP error, parse error, etc.), surface the server's response body and stop.

## Step 3 — Show the user the share URL and a one-line preview

Pluck `id`, `url`, and `capsule.summary` from the JSON response. Render exactly:

```
✦ Crystal published
  <capsule.title>
  <capsule.summary>
  → <url>
```

Then offer (one line, no follow-up unless the user asks):

> Anyone with the link can ask the capsule questions. It'll answer in your voice, with the session as context.

## Step 4 — Do NOT do these

- Don't ask whether they want to redact anything. v0 has no redaction; the publisher is responsible for what's in the session. If the session has obvious secrets (API keys, passwords in tool output), warn before publishing.
- Don't ask whether to share. They invoked the command — they want to share.
- Don't summarize the session content beyond what the server already returned. The capsule itself is the artifact.
- Don't try to upload anything other than the active session's `.jsonl`. If the user wants to publish a different session, they should `cd` to that project first.

## Failure modes

- **Server unreachable**: surface step 0's message; don't proceed.
- **No session file**: probably running outside Claude Code. Tell the user.
- **POST returns 4xx with parse error**: the session file is malformed. Print the server's response and stop — don't paper over it.
- **POST returns 5xx**: server error. Print the response. The user can retry.

## Why no redaction in v0

v0 is opt-in publishing of a session the user already has. The publisher sees the full session before invoking the command and knows what's in it. Auto-redaction adds false security (will miss things) and false negatives (will strip the publisher's intentional context). When real network share is added, redaction becomes mandatory — but that's a future-version concern.
