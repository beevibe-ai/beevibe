---
name: beevibe-team-mesh-tool-choice
description: >
  Choose the right coordination tool. Use whenever you're about to act on or
  with another agent — picks among ask (one-shot reasoning question),
  negotiate (multi-round with stake), report_blocker (upward escalation when
  blocked), check_work_status (DB read for status), revise_task (parent
  unblocking subordinate), and the find_* discovery tools. Picking wrong
  wastes rounds, sessions, and peer capacity. Team and org agents only — IC
  agents have a smaller surface (only respond_ask, report_blocker) and don't
  need this skill.
---

# Mesh Tool Choice (team/org only)

Picking the right tool is the highest-leverage decision before any cross-agent action. Wrong tool wastes a peer's session, burns negotiation rounds, or sends the wrong escalation signal.

## Decision tree

| Need | Tool | Why |
|---|---|---|
| Their reasoning, judgment, or context (lateral or downward) | `ask` | One-shot; spawns peer's session for an answer |
| Status of work I delegated | `check_work_status` | DB read; no session spawn — fastest |
| Back-and-forth proposals with stake (resource split, conflicting plans) | `negotiate` | Multi-round; both sides commit time |
| I'm blocked, need parent help | `report_blocker` | Marks task blocked; spawns parent async |
| My subordinate is blocked, I have a fix | `revise_task` | Transitions blocked → needs_revision with feedback |
| Delegate fresh work | `create_task` | Creates a task assigned to subordinate |
| Find the right target | `find_up`, `find_subordinates`, `find_peers`, `get_agent_profile` | Resolve agent ids before action |

## Common mistakes (and what to use instead)

- **`ask` for status of delegated work** → wastes peer's session for data already in DB. Use `check_work_status(agent_id)`.
- **`negotiate` for status checks or simple questions** → burns rounds + peer capacity. Use `ask` (or `check_work_status` for status).
- **`report_blocker` for peer disagreements** → bounces back; parents can't resolve lateral disputes. Use `negotiate` (or `ask` if exploratory).
- **`negotiate` against an IC** → server rejects with `cannot_negotiate_with_ic` (M9.1 guardrail). For downward delegation use `create_task`. For asking an IC for context use `ask`.
- **`escalate_to_humans` for internal blockers** → escalation is for stuck inter-team negotiations only. Use `report_blocker` for vertical issues.

## Find the right agent first

Before any of the above, resolve who you're targeting:

- **Direct parent** → `find_up()` — for `report_blocker` target
- **Subordinates** → `find_subordinates()` — for `create_task` assignee + downward `ask`
- **Peers** → `find_peers()` — for lateral `ask` / `negotiate`
- **Verify before action** → `get_agent_profile(agent_id)` to confirm role + hierarchy_level

## Examples

**"I want to know if ic-alice finished the migration"**
→ `check_work_status(ic-alice.id)` (NOT ask — it's a status query)

**"I want ic-alice's read on whether we should use library X"**
→ `ask(ic-alice.id, "Do you think library X fits our migration constraints?")` (downward ask for reasoning)

**"team-marketing and I disagree on the launch date"**
→ `negotiate(team-marketing.id, "Propose: launch on date Y because Z")` (stake-bearing, multi-round)

**"I can't proceed because the deploy creds are missing"**
→ `report_blocker(task_id, "Missing deploy credentials for env X")` (upward, blocking)

**"My subordinate ic-bob reported he's blocked on missing creds — I just got the creds added"**
→ `revise_task(bob_task_id, "Creds are now in vault under path Y")` (downward unblock)

**"Need to delegate the auth refactor to ic-alice"**
→ `find_subordinates()` → confirm alice is suitable → `create_task(intent="...", agent_id=alice.id, repo_url="...")` (see `beevibe-team-task-creation`)

## When you're spawned by someone else's mesh call

This skill is about INITIATING. If you were spawned because someone called `ask(target=YOU, ...)` or `negotiate(target=YOU, ...)`:

- For ask → `beevibe-mesh-ask-responder`
- For negotiation → `beevibe-team-mesh-negotiation` (peer side)
