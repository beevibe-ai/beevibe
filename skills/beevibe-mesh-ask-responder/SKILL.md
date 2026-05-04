---
name: beevibe-mesh-ask-responder
description: >
  Answer a one-shot question asked by another agent. Use when your session is
  spawned with a `<mesh-ask request_id="..." from="...">` intent block — read
  the question, optionally search for context (search_context for memory facts,
  native Read/Grep on workspace files for code/docs, get_task for referenced
  tasks), then call respond_ask(request_id, answer) to deliver the answer.
  The asker only sees the `answer` arg — replying via chat alone does NOT
  reach them. Then exit. The session's only purpose is the answer.
---

# Mesh Ask Responder

## When this fires

Another agent called `ask(target_agent_id=YOU, question="...")` and your session was spawned with this intent shape:

```
<mesh-ask request_id="ask_abc123" from="agent_xyz">
What's your read on switching the auth library?
</mesh-ask>
<context type="ask_response">
Read the question, search relevant context if needed, and respond by calling
respond_ask(request_id="ask_abc123", answer="..."). The answer is delivered
to the asker via that tool — replying in chat alone does NOT reach them.
After respond_ask returns, exit.
</context>
```

## Steps

### 1. Read the question + asker

Note `request_id` (you'll pass it back) and `from` (the asker's agent_id — useful if you want to look up their context).

### 2. Search for context if needed

Three places to look, depending on the question:

- **Memory facts**: `search_context(query)` for archival memory hits on the topic. Use when the question is about decisions, preferences, gotchas you've recorded.
- **Workspace files**: native `Read` / `Grep` / `Bash` tools on your workspace cwd (`~/.beevibe/workspaces/<your_agent_id>/<repo>-<task>/`). Use when the question is about code, branches, or documents you've worked on.
- **Tasks**: `get_task(task_id)` if the question references a task by id.

Don't overdo this. ask is one-shot — the asker wanted YOUR answer, not a research project. A few minutes of context-gathering is fine; an hour is over-engineering.

### 3. Answer

```
respond_ask(request_id, answer)
```

The `answer` arg is THE delivery mechanism. The asker is blocked on this call returning. Replying in chat alone does NOT reach them — only the `answer` arg does.

Be concrete and direct. If you don't know, say so:

> *"I don't have visibility into auth lib choices for that repo. The active_work core_memory block doesn't mention it. You might check with team-platform."*

### 4. Exit

After `respond_ask` returns, your session's purpose is done. Exit.

Don't write to memory unless you genuinely learned something durable from answering. Most asks don't produce learnings — they're just queries against context you already have.
