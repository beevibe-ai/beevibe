---
name: beevibe-post-blocker-revision
description: >
  Handling parent-agent unblock guidance after you previously called
  report_blocker. Use when your session resumes with `<context type="revision"
  source="parent_agent" from="blocked">` — your parent has decided how to
  address the blocker you reported. Read their guidance, re-evaluate the task
  from where you stopped, proceed if the guidance resolves the blocker; if
  not, call report_blocker AGAIN (not escalate_to_humans — escalation is for
  inter-team negotiation deadlocks, not internal blockers). After resolution,
  save_memory the resolution rationale, then update_progress and exit.
---

# Post-Blocker Revision

## When this fires

Your session resumes with this in the intent:

```
<context type="revision" source="parent_agent" from="blocked">
Your parent agent has resolved the blocker you reported. Their guidance for proceeding:
<their feedback>

Address the feedback and re-submit via update_progress.
</context>
<task id="..."/>
```

You're resumed via `--resume <prior_cli_session_id>`, so your conversation history shows your `report_blocker` call and what state you left things in.

## This is structurally similar to but DIFFERENT from a human revision

The shape is the same as `<context type="revision" source="human">` (see `beevibe-session-resume`), but the semantics are different:

- **Human revision** = "your output was reviewed; here's what to change"
- **Parent unblock** = "I've decided how to address what stopped you; here's how to proceed"

The framing matters: the parent has authority to declare the blocker resolved. Don't treat their guidance as one of many options — treat it as the path forward.

## Steps

### 1. Re-orient

Look at your conversation history:

- Where did you stop?
- What was the blocker description?
- What had you tried?

### 2. Read the parent's guidance carefully

The guidance specifies HOW to address the blocker, not what to do *differently overall*. Common shapes:

- "Use library Z, not X"
- "The credentials are in <location>"
- "Skip Y for now, we'll address it next sprint"

### 3. Decide if the guidance actually unblocks you

- **Yes, addresses the root cause** → proceed with the task confidently. The parent has decided.
- **No, the guidance doesn't unblock** → call `report_blocker(task_id, "Parent's guidance didn't unblock because <specific reason>")` AGAIN. Do NOT call `escalate_to_humans` — escalation is for inter-team negotiation deadlocks, not internal blockers between an agent and its parent.

### 4. Capture the resolution

Before completing, save a memory entry so future similar blockers benefit:

```
save_memory(
  "blocker about <X> was resolved by <Y approach>",
  "decision"
)
```

This builds a tacit playbook over time. Your team's next agent hitting a similar blocker will find your memory in their briefing.

### 5. Complete

Once unblocked work is done, `update_progress(task_id, 'done', "Unblocked: <what changed>. <delivery summary>.")` and exit. See `beevibe-task-completion`.

## Why never escalate_to_humans here

`escalate_to_humans` is for stuck multi-round negotiations between team agents (initiator escalates a deadlock). The blocker → revise_task path is the internal mechanism for vertical (parent ↔ subordinate) issues. Mixing them sends the wrong signal to operators and bypasses the right resolution path.
