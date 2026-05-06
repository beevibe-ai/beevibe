# Escalation Triggers

When to call `escalate_to_humans` BEFORE hitting the server-enforced max_rounds. Early escalation is cheaper than burned rounds — humans review faster on fresh context, and the negotiation transcript is shorter.

## Strong triggers (escalate now)

- **Same root disagreement, 2+ rounds**: you and the peer keep circling around the same fundamental priority/data interpretation/value judgment. More rounds won't fix this.
- **Information you both lack**: the resolution requires information neither agent has. Burning rounds doesn't conjure the info. Escalate with `open_questions` listing what's unknown.
- **Cross-team policy conflict**: your team's standard operating procedure conflicts with the peer's. This is an organizational decision, not an agent decision.
- **Resource conflict that requires human authority**: budget, headcount, deadline — agents shouldn't unilaterally settle these.

## Weak triggers (one more round is fine)

- **The peer's last counter was better than the prior one** — you're converging; one more round to land it.
- **You haven't presented your strongest proposal yet** — final-round material; show it before escalating.
- **The peer asked a clarifying question** — answer it; don't escalate just because the conversation isn't done.

## How to escalate well

```
escalate_to_humans(
  negotiation_id,
  summary,        // ONE shared, neutral statement
  proposals,      // 2-3 concrete options
  open_questions, // what YOU don't know
)
```

### `summary`

Single shared problem statement. Neutral phrasing — both you and the peer should be willing to sign off on this framing. The human reviewer reads this first; it sets the frame.

Bad summary: *"Peer keeps refusing my proposal."*
Good summary: *"We're stuck on whether to allocate 3 or 5 engineers to the migration. Root disagreement is risk tolerance vs. timeline pressure."*

### `proposals`

Submit 2-3 options:

1. **Your last proposal** — concrete, with rationale
2. **A concession version** — what you'd accept if forced to compromise
3. **A radical fallback** — alternative path entirely (e.g., "defer the work")

Each proposal: title + description. The human will pick one (or invent their own).

### `open_questions`

Things YOU don't know that humans might:

- Strategy / quarter goals not encoded in your memory
- Cross-team commitments
- Resource availability you can't query
- Recent decisions made out-of-band

Don't dump everything you don't know — only what's load-bearing for THIS resolution.

## After escalating

`escalate_to_humans` is terminal for your session — the peer's blocked `respond_negotiate` gets a sentinel, you exit. The executor will re-dispatch you with the resolution as `post_escalation` context (see `post-resolution.md`).

Do NOT keep working on the contested topic in this session. The human's resolution is the source of truth.
