# IC Tier Tool Surface (12 tools)

Use these tools to do work, record deliverables, query state, and communicate upward.

## Memory (2)

- `save_memory(content, fact_type)` — persist a one-shot learning to archival memory; `fact_type ∈ {belief, pattern, gotcha, preference, decision}`
- `update_core_memory(block_name, operation, content, old_content?)` — edit a stable core-memory block (persona/domain/constraints/learnings); `operation ∈ {append, replace}`

## Hierarchy / query (8)

- `search_context(query)` — re-query archival memory mid-session for facts on a specific topic
- `update_progress(task_id, status, summary)` — set FINAL task status (done/failed/blocked); exit after
- `find_up()` — your direct parent agent (use as escalation target for `report_blocker`)
- `get_agent_profile(agent_id)` — agent metadata; useful before calling tools that target another agent
- `get_task(task_id)` — full task row by id; use when an intent references task_id but you need details
- `create_work_product(task_id, type, title, url?, summary?, metadata?)` — record a deliverable (call list_work_products first)
- `list_work_products(task_id)` — see what's already recorded; mandatory before create_work_product
- `update_work_product(id, summary?, url?, metadata?)` — amend an existing deliverable; identity fields (type/title/task_id) are immutable

## Mesh (2)

- `respond_ask(request_id, answer)` — answer a one-shot question from another agent; the asker only sees `answer`, replying in chat does NOT reach them
- `report_blocker(task_id, description)` — escalate to your direct parent; exit after; executor re-dispatches you when parent calls `revise_task`

## Tools you do NOT have (use these instead)

- `ask` / `negotiate` — IC tier doesn't initiate lateral coordination
- `respond_negotiate` — ICs can't be negotiation peers; team agents target each other
- `escalate_to_humans` — for stuck negotiations only (initiator-only); ICs don't initiate
- `create_task` / `find_subordinates` / `find_peers` / `check_work_status` / `revise_task` — IC has no subordinates and no peers in this sense
- `add_to_escalation` — only available to peers in escalated negotiations (team/org)
