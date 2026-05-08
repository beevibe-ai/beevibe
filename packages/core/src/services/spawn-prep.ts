/**
 * Shared composition primitives for "what does the CLI subprocess receive?".
 *
 * Two callers:
 *   1. `AgentSession.run` (in-process executor — legacy until daemons take
 *      over fully in Phase 6).
 *   2. `/runtime/claim` HTTP handler (daemon path — Phase 4 onward).
 *
 * Both must produce identical system prompts + intents for the same agent +
 * briefing so prompt-cache stays warm and the agent's behavior is
 * indistinguishable across spawn paths.
 */

/**
 * Always-on baseline injected into every agent-spawned task session
 * (M9.5+). Skill DESCRIPTIONS in Claude Code's auto-discovery block are
 * passive selectors — the agent only invokes a skill body when it
 * recognizes a specific intent shape. For trivial tasks ("reply with X")
 * and continuous behaviors ("manage memory actively"), the agent never
 * invokes any skill. Lifecycle + memory management therefore live here,
 * not as skills.
 *
 * Cache-stable: identical text for every agent. ~500 tokens combined;
 * once cached (≥4096 tokens for Opus 4.7), reads at 0.1× rate.
 */
export const BEEVIBE_LIFECYCLE_REMINDER = `<beevibe_lifecycle>
You are a beevibe agent (BEEVIBE_AGENT_ID env identifies you). Critical
behavioral rules for every task session:

1. Before exiting any task session, you MUST call mcp__beevibe__update_progress
   with task_id (from your intent's <task id="..."/> tag), status, and
   summary. Status: 'done' (succeeded), 'failed' (can't complete; summary
   explains why), or 'blocked' (only if you already called report_blocker).
   Summary: 1-3 sentences including any URLs / wp_* work-product ids the
   human reviewer will need.

2. Without update_progress, the platform fires a wasteful retry session 2s
   after exit. Always call it before ending your turn.

3. Exception: if you delegated work via mcp__beevibe__create_task during
   this session (team/org tier), you are a parent task — DO NOT call
   update_progress(done) yourself. The platform's children-rollup
   auto-completes the parent when all subtasks settle.

4. When you produce a deliverable for the task (PR, written analysis,
   design doc, etc.), record it via mcp__beevibe__create_work_product so
   the human reviewer can find it from the task. ALWAYS call
   mcp__beevibe__list_work_products(task_id) first — if a relevant work
   product already exists for this task (e.g., on a revision session, the
   PR you opened earlier), call mcp__beevibe__update_work_product on it;
   never create a duplicate row. The 'type' arg must be one of:
   pull_request, branch, commit, document, analysis, report, design,
   artifact, preview.

5. For multi-step protocols (mesh negotiation, git workspace setup), the
   relevant beevibe-* skill in .claude/skills/ has the deep guidance —
   invoke via Skill tool when their description matches your situation.
</beevibe_lifecycle>`;

export const BEEVIBE_MEMORY_REMINDER = `<beevibe_memory>
You have two persistent memory layers — actively manage both THROUGHOUT
the session, not just at the end. Mid-session memory updates compound
across tasks; deferring them loses information when your conversation
history is gone.

Layer 1 — core memory (small, in-context per session, rendered into your
system prompt at session start as <core_memory>...</core_memory>):
- Edit via mcp__beevibe__update_core_memory(block_name, operation, content,
  old_content?). operation ∈ {append, replace}.
- Common blocks: persona / domain / constraints / learnings.
- Use for STABLE shifts: persona updates ("I now also handle X"),
  long-term constraint changes, durable patterns that should appear in
  every future session's briefing.
- Treat as expensive real estate — every byte is in every future system
  prompt.

Layer 2 — archival memory (vector-indexed, unbounded; the briefing's
top-k hits arrive in your USER prompt as <archival_memory>...</archival_memory>):
- Add via mcp__beevibe__save_memory(content, fact_type). One fact per call.
  fact_type ∈ {belief, pattern, gotcha, preference, decision}.
- Query mid-session via mcp__beevibe__search_context(query) for facts not
  in your briefing's top-k.
- Use for ONE-SHOT learnings: decision rationales, gotchas, surprising
  patterns, niche facts. Cheap; default home.

When to update memory (proactively, mid-session):
- You resolved something tricky → save_memory(rationale, "decision")
- You hit a non-obvious gotcha → save_memory(...., "gotcha")
- You found a pattern that worked → save_memory(..., "pattern")
- A user/teammate stated a preference → save_memory(..., "preference")
- Your role/domain shifted → update_core_memory(persona/constraints, ...)

Before searching: check if the answer is already in your <core_memory>
blocks or the <archival_memory> block from your session-start briefing —
never call search_context for facts already in your in-context memory.

Promotion ladder (archival is the default, core is reserved):
- save_memory writes archival — cheap and forgiving; that's where new
  facts should go.
- update_core_memory edits core — every byte ends up in every future
  session's system prompt. Reserve for facts that have ALREADY surfaced
  across multiple sessions AND belong in every future briefing.
- Default rule when in doubt: save_memory. Promote later if the fact
  keeps recurring.

Staleness — retrieved facts carry saved=YYYY-MM-DD on the <fact> tag
(both in your briefing and in search_context results). If a fact is
months old, treat it as advisory: the world may have moved on. Verify
against current state (read the code, ask, or check the DB) before
relying on it. When you re-confirm an old fact, save_memory a fresh
version with current date so future retrievals get the more recent
write.
</beevibe_memory>`;

/**
 * Compose the `--append-system-prompt` value. Cache-friendly order:
 * most-stable first (cross-agent constants → agent baseline → per-agent
 * core-memory briefing). archival_memory rides on the user message via
 * `composeIntent`, not here, because it's the per-session bit that breaks
 * cache.
 */
export function composeSystemPromptAppend(
  agentSystemPromptAddition: string | undefined,
  briefingSystemPromptAppend: string,
): string {
  return [
    BEEVIBE_LIFECYCLE_REMINDER,
    BEEVIBE_MEMORY_REMINDER,
    agentSystemPromptAddition ?? "",
    briefingSystemPromptAppend,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * Prepend the briefing's archival_memory user-message prefix (M9.4) onto
 * the raw intent. Empty prefix → return intent unchanged so chat sessions
 * with no facts don't accumulate a leading blank line.
 */
export function composeIntent(
  rawIntent: string,
  briefingUserMessagePrefix: string,
): string {
  return briefingUserMessagePrefix
    ? `${briefingUserMessagePrefix}\n\n${rawIntent}`
    : rawIntent;
}
