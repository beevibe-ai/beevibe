# Real streaming for chat: swap the runtime to Anthropic-direct

**Status:** plan, not work
**Why:** today the chat shows "thinking…" then the whole response appears at once. Root cause: `claude` CLI's `--output-format stream-json` emits one `assistant` message at end-of-turn with the full text — there's nothing finer to stream. To get word-by-word streaming we have to call the Anthropic API ourselves.

This doc is what to consider before starting the work, not the work itself.

---

## What we have today

Path of a chat message right now:

```
browser → POST /chat
            ↓
        api (chatResolver) → enqueue session
            ↓
        scheduler → assign to a runtime
            ↓
        daemon → spawn `claude --output-format stream-json` (CLI subprocess)
            ↓
        claude CLI → talk to Anthropic, emit JSON lines on stdout
            ↓
        daemon spawner → parse line → POST /runtime/events
            ↓
        api → INSERT into session_event
            ↓
        Postgres trigger → pg_notify with {event, id, data}
            ↓
        SseListener → SSE → browser
```

The streaming bottleneck is at the CLI step. `claude` only emits one `{type:"assistant",content:[{type:"text",text:"FULL_RESPONSE"}]}` line per assistant turn. No `content_block_delta`. We verified by running the CLI directly.

So today's "streaming" is **turn-by-turn, not token-by-token**:
- Tool call → step appears
- Tool result → step appears
- Final assistant text → step appears (whole text at once)

For a one-turn answer with no tool calls, you see exactly one event at the end. That's the "thinking → full response pop in" experience.

## What we want

Word-by-word streaming, the same feel as claude.ai or ChatGPT. To get it, the runtime needs to call Anthropic's `/v1/messages` endpoint directly with `stream: true`, then forward each `content_block_delta` event as a session_event row.

## Target shape

Replace [packages/core/src/adapters/claude-code/runtime.ts](packages/core/src/adapters/claude-code/runtime.ts) with an `AnthropicDirectRuntime` that uses `@anthropic-ai/sdk`. The interface (`Runtime.execute(ctx)` with `onStep`) stays the same — only the implementation changes.

```ts
// rough sketch only
export class AnthropicDirectRuntime implements Runtime {
  async execute(ctx: RuntimeExecuteContext): Promise<RuntimeResult> {
    const stream = await anthropic.messages.stream({
      model: ctx.model,
      messages: [{ role: "user", content: ctx.intent }],
      tools: discoverTools(ctx),  // ← the hard part
      max_tokens: 4096,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        ctx.onStep?.({ kind: "agent", description: event.delta.text, timestamp: now() });
      } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        ctx.onStep?.({ kind: "tool_call", tool: event.content_block.name, ... });
      }
      // ...
    }

    return { status: "completed", ... };
  }
}
```

Each `text_delta` becomes a fine-grained `session.step` event. The existing chat-client already concatenates `agent`-kind step contents into `streamingText` — it'll fill in progressively.

## The hard parts

These are where the real work is, not the streaming loop itself.

### 1. Tool / MCP integration

Today: `claude` CLI auto-discovers tools from MCP servers configured in `~/.claude/`. The CLI handles tool-use loops internally — when Claude wants to call a tool, the CLI invokes the MCP server, gets the result, and continues the conversation.

Direct mode: we own the tool-use loop. We have to:
- Enumerate available tools and ship their schemas in the `tools` parameter
- Receive `tool_use` content blocks in the stream
- Call the right MCP server, get the result
- Append a `tool_result` message and re-stream

This is **the core architectural change**. The MCP plumbing currently lives in claude CLI and is opaque to us. We'd need to either:
- (a) Reuse the MCP transport that already exists in `packages/api/src/runtime/router.ts`-ish layer and call MCP servers ourselves
- (b) Skip tools entirely for chat (just text completion) — much simpler but agents lose their hands

(a) is the right call for parity. Plan on it being half the project.

### 2. The daemon's role

The daemon today exists to:
- Spawn the CLI subprocess on the user's machine
- Stream stdout back over HTTP
- Stay independent of api server uptime

If the runtime calls Anthropic directly, **what's the daemon for?**

Options:
- **Keep daemon, move runtime into it.** The api stays a coordinator; the daemon owns the Anthropic API call. Still gets you per-user API keys, local MCP access, file-system tool execution on user's box. Probably right.
- **Drop daemon, run runtime in api.** Simpler topology but `Edit`/`Bash` tools can't run on the user's filesystem from a server. Only works for chat that doesn't touch local files.

Decide this before writing code. Daemon-side is the right default for keeping `claude` parity.

### 3. Auth model

Today: each agent has a `runtime_config` pointing at the user's Claude OAuth setup; the daemon spawns `claude` which uses the user's existing auth.

Direct: each agent needs an Anthropic API key. Either:
- User provides one via the dashboard → stored encrypted, used by the daemon
- Org-level key with usage tracking per agent (more work, more accurate billing)

The existing `api_key` column on `agent` could carry this, but it's currently a `bv_a_` identity token, not an Anthropic key. Add a separate column or a `runtime_config.anthropic_api_key` field.

### 4. Cost tracking

Today: `claude` CLI returns `total_cost_usd` in the `result` message. We persist this somewhere.

Direct: we compute from `usage` tokens × the model's published rates. Easy but a new code path. Look at how memory/promotions and rate-limit logic already use these numbers.

### 5. Per-agent system prompt + memory

Today: the agent's persona/memory is composed into the CLI invocation via `--append-system-prompt`. Direct mode does the same thing via the `system` parameter on `messages.create`. Behavior-equivalent, just a different field.

### 6. Resume semantics

Today: `claude` CLI supports `--resume <session_id>` to continue a prior conversation, and the daemon passes one through. Direct mode has to maintain conversation history client-side and pass it as the `messages` array. Already implicit in how we store session_event rows; the runtime would replay them.

### 7. Tests

Today: `runtime.test.ts` mocks the CLI subprocess. Direct mode would mock `anthropic.messages.stream()`. The chat-stream.test.tsx on the web side doesn't change — same `session.step` events.

## Tradeoffs vs status quo

| | claude CLI (today) | Anthropic-direct |
|---|---|---|
| Streaming feel | one chunk per turn | word-by-word |
| Tool ecosystem | inherited from claude (free) | reimplement MCP plumbing |
| Cost tracking | provided in result | compute from usage tokens |
| Auth | user's claude install | Anthropic API key |
| Local file tools | work (CLI is local) | only if daemon stays |
| Model lock-in | claude only | switch model per agent (GPT, Gemini) easy later |
| New dependency | none | `@anthropic-ai/sdk` |

The "switch model later" line is real value if you ever want non-Claude agents. Not the main motivation here but it's a nice consequence.

## Migration order

Don't switch all agents at once. Sketch:

1. **Add the new runtime alongside the old.** `runtime_config.kind` already exists; add a new value `"anthropic-direct"`. The registry routes to either implementation.
2. **Plumb the new runtime through the daemon.** Same `Runtime.execute()` interface, daemon doesn't care.
3. **Ship without tool support first.** Bare chat, no tools. Validate the streaming loop end-to-end. Multi-day fix-and-iterate.
4. **Add tool plumbing.** Use the existing MCP-server side of the codebase to invoke tools. This is where parity work concentrates.
5. **Migrate one agent's `runtime_config.kind` as a beta**. The "Team agent" probably. Other agents stay on CLI until verified.
6. **Default new agents to anthropic-direct.** Keep CLI as opt-in for local-tool agents.
7. **Eventually drop the CLI integration** once tool parity is solid.

## Effort estimate

Honest numbers, not optimistic:

| Phase | Engineer-days |
|---|---|
| New runtime stub, streaming text, tests | 1–2 |
| Daemon plumbing + config knob | 0.5 |
| Tool/MCP loop in runtime | 3–5 (this is the iceberg) |
| Cost + usage tracking | 0.5 |
| Auth UI + secret storage | 1 |
| End-to-end browser test on multi-step prompts | 1 |
| Migration of one real agent + observation | 1 |
| Total | **8–11 days** |

## Decisions to make before starting

1. **Where does the runtime live: daemon or api?** Recommend daemon for tool parity.
2. **API key storage: per-agent or per-user?** Recommend per-agent (`runtime_config.anthropic_api_key`).
3. **Tools v1: full MCP parity or text-only first?** Recommend text-only ship, then tools as separate PR.
4. **Cutover plan: opt-in flag or per-agent kind?** Recommend per-agent `runtime_config.kind` so users can A/B.
5. **Keep claude CLI runtime forever, or sunset?** Recommend keep as a `runtime_config.kind` option — some agents really do need local-machine file access via the CLI.

## Open questions

- Does `@anthropic-ai/sdk` streaming API give us the `usage` block at end of stream? (Need to check — current cost tracking depends on it.)
- Does `prompt caching` work the same way via the SDK as via the CLI? (Important for cost — the CLI does a lot of caching for us today.)
- What's the behavior on rate-limit hits? CLI handles backoff; we'd need to in the SDK call too.
- For local-tool agents (Edit, Bash on user's filesystem), do we keep the CLI runtime forever, or build a separate local-tool-router? CLI is the easier answer.

## Related code touch points

If/when this lands, these are the files that change:

- [packages/core/src/adapters/claude-code/runtime.ts](packages/core/src/adapters/claude-code/runtime.ts) — replaced or made one of many runtime kinds
- [packages/core/src/adapters/claude-code/stream-json.ts](packages/core/src/adapters/claude-code/stream-json.ts) — irrelevant for direct mode, but stays for CLI fallback
- [packages/core/src/adapters/runtime-registry.ts](packages/core/src/adapters/runtime-registry.ts) — route by `runtime_config.kind`
- [packages/core/src/services/agent-session.ts](packages/core/src/services/agent-session.ts) — same `onStep` contract, no change expected
- [packages/daemon/src/spawner.ts](packages/daemon/src/spawner.ts) — if daemon runs the new runtime, this becomes an import not a subprocess spawn
- new: `packages/core/src/adapters/anthropic-direct/runtime.ts`
- new: `packages/core/src/adapters/anthropic-direct/tools.ts` (MCP loop)
- migration: add `runtime_config.kind = 'anthropic-direct' | 'claude-code'`, plus a per-agent or per-user secret column for the API key

## What I'd do first if picking this up

1. Spend half a day reading the current `ClaudeCodeRuntime.execute()` end-to-end so you understand what events it currently emits and when.
2. Build a tiny standalone script: `anthropic.messages.stream({messages: [{role:"user", content: "hi"}]})` and log every event. Confirm the SDK shape matches expectations.
3. Sketch the tool loop on paper. This is the part that catches teams off-guard.
4. Then start the runtime stub.

Don't start by writing the registry routing or migration — that's the polish, not the substance.
