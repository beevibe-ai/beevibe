# Post-Resolution Handoff

After a human resolves an escalated negotiation, both sides receive a fresh dispatch. The platform's `EscalationService.resolve` writes:

- For the **initiator** (whose original task was tied to the negotiation): re-queues the existing task with `next_dispatch_context.kind = 'post_escalation'`, `role = 'initiator'`
- For the **counterparty**: creates a SYNTHETIC task with `next_dispatch_context.kind = 'post_escalation'`, `role = 'counterparty'`

The executor picks both up within ≤30s and re-dispatches with `--resume <prior_session_id>`.

## Intent shape (both roles)

```
<context type="post_escalation" role="initiator|counterparty">
A negotiation about this task was resolved by a human reviewer.
Resolution: <chosen proposal title> — <description>
Additional guidance: <notes if present>
<role-specific tail>
</context>
<task id="..."/>
```

## Initiator role — continue your task

You have the original task (the one tied to the negotiation). The resolution tells you what was decided.

**Do**:
- Read the resolution carefully — this is the final answer; don't re-litigate
- Continue the work that was blocked by the negotiation
- Apply the resolution as guidance (e.g., if it says "use X", use X)
- Save memory: `save_memory("Negotiation about Y resolved with Z because ...", "decision")`
- When done, `update_progress(done)` and exit

**Don't**:
- Re-negotiate. The human's call is final.
- Question the resolution. If you genuinely think it's wrong, `report_blocker` with that specific concern (rare).

## Counterparty role — synthetic task

You have a synthetic task created by the platform. There's no original work for you to "continue" — you were the peer in someone else's negotiation, and the platform wants to make sure you also see the resolution.

**Do**:
- Read the resolution
- `save_memory("Negotiation about Y resolved with Z because ...", "decision")` — same as initiator
- Complete any related follow-up on YOUR end (e.g., update your team's plan, notify your subordinates if affected, file a memory note for your domain)
- `update_progress(synthetic_task.id, 'done', "Acknowledged resolution; updated team plan to reflect Z.")`
- Exit

**Don't**:
- Treat the synthetic task as new "real" work. It exists to give you a place to write the resolution into your memory and tie the loose end.
- Ignore the resolution and exit without acknowledging. The synthetic task expects an `update_progress`.

## Resolution proposal shape

The resolution is a `ResolutionProposal`:

```ts
{
  title: string;                         // "Use library X"
  description: string;                   // "After review, library X is preferred because..."
  source: 'initiator' | 'counterparty' | 'human';
  source_index?: number;                 // for source != 'human', which proposal slot was chosen
}
```

`source` tells you whose proposal won (or if the human invented their own). Useful context for memory writeback.

## Edge cases

### "The resolution doesn't actually resolve my problem"

Rare. If the resolution is genuinely incomplete (e.g., refers to a system you don't have access to), call `report_blocker` on your task explaining why. Don't try to fix it via another negotiation — that's noise.

### "The resolution is wrong / based on bad info"

Even rarer. The human had your proposals + open_questions; they chose. Trust the call. If your subsequent work proves it was wrong, that's a future revision/blocker, not a re-litigation of THIS negotiation.

### "I'm a synthetic-task counterparty but my team's plan needs to change significantly"

Call `update_progress(synthetic_task.id, 'done', "...")` first to close the synthetic task. Then if you genuinely need to revise YOUR team's broader plan, that's a separate task (delegated by you to a subordinate, or initiated as new work).
