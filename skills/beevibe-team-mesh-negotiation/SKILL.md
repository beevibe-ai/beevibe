---
name: beevibe-team-mesh-negotiation
description: >
  Multi-round negotiation protocol — covers both initiator and peer roles. Use
  when about to call negotiate(), when receiving a `<negotiation>` intent
  block as a peer, or when receiving an 'escalated' sentinel from a blocked
  respond_negotiate. Covers proposal crafting, counter-strategy, deadlock
  detection, when to accept early, escalation triggers, and post-resolution
  behavior. Do NOT use for one-shot peer questions (use mesh-ask-responder)
  or upward blockers (use report_blocker).
---

# Mesh Negotiation Protocol

You're either initiating a negotiation, responding to one, or handling its escalation. Each role has its own protocol below.

## Pre-flight: pick the right tool first

`negotiate` is for situations where there's STAKE on both sides and resolving requires back-and-forth. Common confusions:

- For a one-shot question → use `ask` (no rounds, no stake)
- For status queries → use `check_work_status` (DB read; no session spawn)
- For blocked work needing parent help → use `report_blocker`
- For downward delegation to a subordinate → use `create_task`

If none of those fit and the disagreement is real, `negotiate` is correct.

---

## Initiator side (you call `negotiate`)

You're proposing something to a peer. The server creates the negotiation row, spawns the peer, and blocks until they respond.

### Link to your task

If your negotiation pertains to a specific task you're working on (the common case — you're negotiating WHILE making progress on a task), pass `task_id` to `negotiate`:

```
negotiate(peer_id, proposal, task_id="<your_current_task_id>")
```

This stamps the negotiation row's `task_id` so:

- If escalated, the human reviewer sees which task is blocked
- Post-escalation re-dispatch finds your existing task to continue (vs creating a synthetic one)
- Other agents and the audit log can correlate the negotiation with the task

Omit `task_id` only when negotiating about something orthogonal to your current task (rare — usually means you should reconsider whether `negotiate` is the right tool).

### First proposal

Be specific:

- **What** is being proposed (concrete action, scope, allocation)
- **Who** does what (assign owners if relevant)
- **By when** (timeline if relevant)
- **Why** — the rationale + tradeoffs

Phrase as: *"I propose X because Y; what do you think?"*

A specific proposal gets a specific response. Vague proposals get vague counters and burn rounds.

### Reading the peer's counter

A counter is data, not opposition. Each round, identify:

- **Signal**: what the peer changed (their concerns about your proposal)
- **Non-negotiables**: what they kept (their hard constraints)

Iterate toward something that addresses their signal while you keep YOUR non-negotiables.

### When to accept

After 2-3 rounds, if the peer's counter addresses your concerns, accept. Don't max out rounds for the sake of "winning" — burning turns has cost (tokens, time, peer capacity).

`respond_negotiate(neg_id, 'accept', "Agreed. Proceeding with <chosen plan>.")` — terminal; the negotiation is closed.

After accept returns, immediately persist the decision so future sessions don't re-litigate:

```
save_memory("Negotiation about <topic> with <peer> resolved with <chosen approach> because <rationale>.", "decision")
```

Then continue your task with the agreed plan.

### When to reject

`reject` is rare and terminal — use it only when no version of the proposal is workable from your side and there is no path forward via counter. Examples: the proposal would violate a hard constraint you can't move (compliance, capacity, ownership boundary) AND the peer's framing leaves no room to refactor it.

If you find yourself reaching for `reject`, first ask: would a counter that surfaces my hard constraint move the conversation forward? If yes, counter. If no:

```
respond_negotiate(neg_id, 'reject', "Cannot proceed because <hard constraint>. Suggest <alternative path / different peer / different tool>.")
```

After reject:

1. `save_memory("Rejected negotiation about <topic> with <peer> because <hard constraint>. Suggested <alternative>.", "decision")`
2. If the rejection blocks YOUR task and you have no alternative path, call `report_blocker` so your parent can revise scope.
3. Otherwise continue work along the alternative path.

### When to escalate (BEFORE max_rounds)

If you and the peer are circling around the same root disagreement (different priorities, different data interpretation), don't burn the remaining rounds. Call `escalate_to_humans` early — humans review faster on fresh context. See `references/escalation-triggers.md`.

### Server-enforced max_rounds

Server hard-caps at 5 rounds (per-agent configurable). On round N+1 attempt you get:

```
{ error: "MAX_ROUNDS_EXCEEDED", ... }
```

Stop and call `escalate_to_humans` immediately:

```
escalate_to_humans(
  negotiation_id,
  summary,        // ONE shared problem statement, neutral phrasing
  proposals,      // 2-3 concrete options (yours + concession + radical fallback)
  open_questions, // things YOU don't know that humans might
)
```

After this returns, **exit your session** — the human will resolve and the executor will re-dispatch you with the resolution.

### Capacity errors

`mesh_capacity_exceeded` means peer is busy, NOT stuck. Don't escalate. Pivot to other parts of your task that don't depend on this negotiation, OR retry later. Only call `report_blocker` if the negotiation is on the critical path and waiting isn't acceptable.

---

## Peer / responder side (you were spawned with a `<negotiation>` intent)

Your session was spawned because another agent called `negotiate(target=YOU, ...)`. Intent shape:

```
<mesh-negotiate negotiation_id="neg_abc" from="team_X" round="1">
<their proposal>
</mesh-negotiate>
<context type="negotiation_round">
Read the proposal, search relevant context if needed, and respond with
respond_negotiate(negotiation_id, decision, message). Decisions: counter,
accept, reject.
</context>
```

### Read context first

Before responding, gather signal:

- `search_context` for memory facts on the topic
- `get_task` if the proposal references a task you're not aware of
- `check_work_status` to assess your own capacity

This is multi-round; the peer is blocked. Take 1-2 minutes to think; don't take 30.

### Respond shape

```
respond_negotiate(neg_id, decision, message[, counter_proposal])
```

- **`accept`** → terminal; you agree
- **`reject`** → terminal; you decline (rare; usually use `counter` to keep the conversation alive)
- **`counter`** → MUST include a specific counter-proposal in `counter_proposal`. Vague counters waste rounds.

A `counter` BLOCKS your session until the peer's next reply (or until they accept/reject/escalate).

### Counter loop awareness

If you've countered 2+ times and the peer keeps offering similar things, escalation is likely. Make your final counter your BEST — if the peer escalates without your strongest concession on record, the human review is incomplete.

### `escalated` sentinel handling

When your blocked `respond_negotiate` returns:

```
{ decision: 'escalated', escalation_id: 'esc_xyz', message: '...' }
```

The peer escalated. You did NOT initiate; you must NOT call `escalate_to_humans` (initiator-only). Call:

```
add_to_escalation(escalation_id, proposals, open_questions)
```

- NO `summary` arg — the initiator already set it (immutable)
- Your `proposals` should DIFFER from initiator's where you actually disagree. Don't mirror.
- `open_questions` — things in YOUR domain humans should know about that the initiator didn't capture

After this returns, **exit your session**.

---

## Post-resolution behavior

When the human resolves the escalation, both sides receive a fresh dispatch with `next_dispatch_context.kind === 'post_escalation'`. Intent shape:

```
<context type="post_escalation" role="initiator|counterparty">
A negotiation about this task was resolved by a human reviewer.
Resolution: <chosen proposal title> — <description>
Additional guidance: <notes if any>
<role-specific guidance>
</context>
<task id="..."/>
```

### Initiator role

Continue your task with the resolution as guidance. Don't re-negotiate — the human's call is final. Update memory if you learned something:

```
save_memory("Negotiation about <X> resolved with <Y> approach because <Z>", "decision")
```

Then continue work; eventually `update_progress(done)` and exit.

### Counterparty role

You have no original task to continue (you were a peer in someone else's negotiation). The platform created a SYNTHETIC task for you with the post-escalation context. Steps:

1. `save_memory` the resolution (same as initiator)
2. Complete any related follow-up on YOUR end (update memory, finish loose ends)
3. `update_progress(synthetic_task_id, 'done', "Acknowledged escalation resolution.")`
4. Exit

See `references/post-resolution.md` for edge cases.

---

## Deeper detail (load on demand)

- Counter strategy + when to accept early: `references/counter-strategy.md`
- Early escalation triggers: `references/escalation-triggers.md`
- Post-resolution role-specific handoff: `references/post-resolution.md`
