# Alignment Meeting — Plan

## The idea

You sit in a real meeting with your team agent to keep your specialists aligned.

Each specialist agent piles up memory over time — core blocks (persona, domain,
constraints, active_context) plus archival facts (beliefs, patterns, gotchas).
You can't read those walls of text line by line. So a teammate quietly drifts:
it starts believing "agents share memory" when beevibe's actual design is that
**each specialist has self-contained memory**. Next time you ask for a pitch
deck, it builds the wrong story.

The meeting fixes this:

1. **Prep (local gemma).** Before the meeting, gemma reads every specialist's
   memory and turns each one into a short plain-language card — *what this
   teammate believes, knows, is working on, and the rules it follows.* Cheap,
   private, offline. No scores, no jargon.
2. **Meet (Claude team agent).** You open a live text meeting. The team agent
   walks you through each teammate's card conversationally. You spot the drift
   in plain conversation: "wait — Dana thinks memory is shared? That's wrong."
3. **Act (apply immediately).** When you confirm a fix, it becomes an action
   item that writes straight back into that specialist's memory, with an audit
   row. The meeting also keeps notes.

**No baseline / no robot truth-checking.** Gemma only makes memory legible. You
judge drift live. That keeps it honest and simple.

**Why gemma vs Claude:** gemma does the bulk, repetitive, sensitive job of
digesting every agent's memory; Claude (the team agent) runs the conversation
and applies fixes — it already has the hierarchy brain and the tools.

---

## Data model (new migration)

Mirrors existing audit-table conventions (`memory_promotion_event`).

```
alignment_meeting
  id              TEXT PK
  team_agent_id   TEXT FK -> agent          -- whose team
  owner_id        TEXT FK -> person
  status          TEXT  ('prepping'|'active'|'wrapped')
  chat_session_id TEXT                       -- drives the live conversation (reuses chat infra)
  notes           TEXT                       -- markdown, accrued during the meeting
  created_at, updated_at, wrapped_at

alignment_digest                             -- gemma's per-specialist card
  id              TEXT PK
  meeting_id      TEXT FK -> alignment_meeting
  agent_id        TEXT FK -> agent           -- the specialist
  summary         JSONB { believes[], knows[], working_on[], rules[] }
  source_block_ids TEXT[]                     -- provenance: what was read
  source_fact_ids  TEXT[]
  model           TEXT                        -- e.g. "gemma..."
  created_at

alignment_action_item                        -- the "action UI"
  id              TEXT PK
  meeting_id      TEXT FK -> alignment_meeting
  agent_id        TEXT FK -> agent           -- specialist being corrected
  kind            TEXT  ('correct_memory'|'note'|'followup')
  title           TEXT                        -- plain language: "Fix Dana: memory is self-contained"
  target_ref      JSONB { type:'core_block'|'fact', block_name?, fact_id?,
                          operation, content, old_content? }
  status          TEXT  ('open'|'applied'|'dismissed')
  applied_session_id TEXT, applied_at
  created_at, updated_at
```

---

## Backend

### Local model (mirrors interview-prep-coach)
- `packages/core/src/ports/local-model.ts` — `LocalModelPort { chat(system, messages, opts): Promise<string> }`
- `packages/core/src/adapters/ollama/ollama-model.ts` — POST `${OLLAMA_BASE_URL}/api/chat`,
  `stream:false`, retry-on-empty (small models return blanks), env
  `OLLAMA_BASE_URL` (default `http://localhost:11434`), `OLLAMA_MODEL` (gemma).

### Service
- `packages/core/src/services/alignment/alignment-service.ts`
  - `prepare(teamAgentId)`: `findSubordinates` -> for each load blocks + recent
    facts -> gemma digest -> persist `alignment_digest` + create meeting (status
    `active`).
  - `applyActionItem(itemId)`: executes write-back through the **real**
    `CoreMemory.applyUpdate` / `FactStore` services (not the MCP layer), records
    audit, flips item to `applied`.

### Repos (postgres adapters)
- `alignment-meeting-repo.ts`, `alignment-digest-repo.ts`, `alignment-action-repo.ts`
  + ports under `packages/core/src/ports/`.

### API routes — `packages/api/src/routes/alignment.ts`
- `POST   /alignment/meetings`                 start (runs prepare, returns meeting + digests)
- `GET    /alignment/meetings`                 list
- `GET    /alignment/meetings/:id`             meeting + digests + action items
- `POST   /alignment/meetings/:id/messages`    talk to the team agent; injects the
                                               digests as meeting context (reuses chat dispatch + chatResolver)
- `POST   /alignment/meetings/:id/action-items` create
- `POST   /alignment/action-items/:id/apply`    write-back now
- `POST   /alignment/action-items/:id/dismiss`
- `PATCH  /alignment/meetings/:id/notes`

### MCP tool for the team agent (so it can act mid-conversation)
- `correct_subordinate_memory(agent_id, block_name|fact_id, operation, content, rationale)`
  in `packages/api/src/tools/` — team/org only, verifies target is a direct
  subordinate (same authz as `create_task`). Creates an action item and (per
  "apply immediately") applies it, with an audit row. This is the cross-agent
  write-back path — `update_core_memory` only touches an agent's *own* memory.

---

## Frontend (`packages/web`)

- `app/(authed)/alignment/page.tsx` (+ `*-client.tsx`) — list of meetings.
- `app/(authed)/alignment/[id]/` — the **meeting room**, the "real meeting, advanced":
  - **Center:** live text transcript with the team agent — reuses chat patterns
    (`useChatStream` SSE, glass bubbles, optimistic send from the rooms pattern).
  - **Right rail, three tabs:**
    - **Teammates** — gemma's digest card per specialist (believes / knows /
      working on / rules). Plain language, progressive disclosure for raw memory.
    - **Action items** — cards with Apply / Dismiss; Apply writes back immediately.
    - **Notes** — editable markdown, auto-appended as decisions land.
  - **Header:** team, date, status, who's in the room.
- `lib/api/client.ts` — add `api.alignment.*`; query keys in `lib/hooks/keys.ts`.

---

## Scope discipline (v1)

- **Text meeting**, not voice. beevibe chat is text-native; interview-prep's
  voice/VAD was specific to that product. Voice is a later add if you want it.
- Gemma digest + live meeting + action items with immediate write-back + notes.
- No auto drift-scoring (you chose "no baseline").

## Build order

1. Migration + domain types.
2. Ollama adapter + LocalModelPort (smallest, testable against your local gemma).
3. AlignmentService.prepare (digest) + repos — verify against real Postgres.
4. API routes + `correct_subordinate_memory` MCP tool + apply path.
5. Web meeting room (list -> room -> tabs).
6. End-to-end dogfood: run a meeting on a real team, catch a planted drift, fix it.

## Open / will confirm as I go
- Exact gemma model tag you have pulled (`ollama list`) for the default env value.
- Whether digests refresh live mid-meeting or are snapshotted at prep time
  (plan assumes snapshot at prep; cheap to re-run on demand).
