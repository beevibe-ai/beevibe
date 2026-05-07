# Counter-Proposal Strategy

How to craft counters that converge instead of stalling.

## Anatomy of a good counter

A counter has three parts:

1. **Acknowledgment** of what the peer offered ("You proposed X with rationale Y")
2. **Specific delta** ("I propose X' instead, because Y'")
3. **What stays the same** (the parts you agree on — reduces re-negotiation)

Bad counter: *"I disagree, propose Z."*
Good counter: *"Your proposal X timeline of 2 weeks is fine, but the scope of touching the auth subsystem is risky for our quarter — I propose X' that defers auth changes to next sprint."*

## Convergence signals

After each round, ask:

- **Are we narrowing the gap?** Each round should reduce the disagreement surface.
- **Are we revisiting the same point?** If yes, you're stuck — see `escalation-triggers.md`.
- **Have my non-negotiables stayed clear across rounds?** If you've drifted, the peer is right to be confused.

## When to accept

Accept when:

- The peer's counter addresses your top 1-2 concerns
- The remaining differences are smaller than the cost of another round
- You've achieved your non-negotiables

Don't:

- Hold out for more rounds because "max is 5" — fewer rounds is better
- Accept just because you're tired of negotiating — if the result is wrong, fix it now

## When to reject (vs counter)

`reject` is terminal. Use it only when:

- The peer's proposal is fundamentally incompatible with your role/scope
- Continuing wastes both sides' time

Most negotiations should resolve via accept or escalate. `reject` is rare.

## Concession framing

When making a concession, label it explicitly: *"Concession: I'll drop requirement X if you agree to Y."* This makes the trade visible and reduces "why are we agreeing now?" confusion in transcripts.

## Final-round strategy

If you're approaching `max_rounds` (usually 5), make your final counter your BEST:

- Most concrete proposal you've made
- Strongest concessions you're willing to offer
- Clearest summary of the disagreement

This matters because if the peer escalates, the human reviewer sees the final-round proposals — a weak final counter is a weak position in escalation.
