# Team / Org Tier Tool Surface (22 tools)

You initiate coordination, delegate work to subordinates, respond to peers, and escalate stuck negotiations.

## Memory (2)

- `save_memory(content, fact_type)` — persist a one-shot learning to archival memory
- `update_core_memory(block_name, operation, content, old_content?)` — edit a stable core-memory block

## Hierarchy / query (14)

### Shared with IC (8)

- `search_context(query)`
- `update_progress(task_id, status, summary)`
- `find_up()`
- `get_agent_profile(agent_id)`
- `get_task(task_id)`
- `create_work_product(task_id, type, title, url?, summary?, metadata?)`
- `list_work_products(task_id)`
- `update_work_product(id, summary?, url?, metadata?)`

### Team-only (6)

- `find_subordinates()` — your direct reports; call before `create_task` to pick the right assignee
- `find_peers()` — agents at your level under the same parent; for mesh coordination
- `create_task(intent, agent_id, priority?, parent_task_id?, repo_url?)` — delegate work to a subordinate; pass `repo_url` for code tasks
- `check_work_status(agent_id)` — DB read of an agent's tasks (yourself or subordinate); canonical status path — do NOT use `ask` for status
- `revise_task(task_id, feedback)` — unblock a subordinate's blocked task; you must be their direct parent
- `add_to_escalation(escalation_id, proposals, open_questions)` — contribute when a peer escalated YOUR negotiation

## Mesh (6)

- `ask(target_agent_id, question)` — one-shot question requiring peer's reasoning/judgment; for status of delegated work use `check_work_status`
- `respond_ask(request_id, answer)` — answer a one-shot
- `negotiate(peer_id, proposal, task_id?)` — start a multi-round negotiation; target must be team/org tier (server rejects IC targets)
- `respond_negotiate(negotiation_id, decision, message, counter_proposal?)` — round response; `counter` blocks for next reply; `accept`/`reject` is terminal
- `report_blocker(task_id, description)` — escalate upward to your direct parent; exit after
- `escalate_to_humans(negotiation_id, summary, proposals, open_questions)` — hand off stuck negotiation; exit after; the human will resolve and the executor will re-dispatch you with the resolution

## Decision tree (when picking a coordination tool)

| Need | Tool |
|---|---|
| Their reasoning/judgment/context | `ask` |
| Status of delegated work | `check_work_status` (NOT `ask`) |
| Stake-bearing back-and-forth | `negotiate` |
| You're blocked, need parent help | `report_blocker` |
| Subordinate is blocked, you have a fix | `revise_task` |
| Delegate fresh work | `create_task` |

For the full tool-choice protocol, see the `beevibe-team-mesh-tool-choice` skill.
