import type { Agent } from "../../domain/agent.js";
import type { CoreMemoryBlock } from "../../domain/core-memory.js";
import type { FactType, MemoryFact } from "../../domain/memory.js";
import type {
  AlignmentMeeting,
  AlignmentDigest,
  AlignmentDigestSummary,
  AlignmentActionItem,
  AlignmentActionKind,
  AlignmentTargetRef,
} from "../../domain/alignment.js";
import {
  alignmentMeetingId,
  alignmentDigestId,
  alignmentActionItemId,
} from "../../domain/ids.js";
import type { AgentRepository } from "../../ports/agent-repo.js";
import type { CoreMemoryBlockRepository } from "../../ports/core-memory-repo.js";
import type { MemoryFactRepository } from "../../ports/memory-fact-repo.js";
import type { EmbeddingService } from "../../ports/embedding-service.js";
import type { LlmProvider } from "../../ports/llm-provider.js";
import type {
  AlignmentMeetingRepository,
  AlignmentDigestRepository,
  AlignmentActionItemRepository,
} from "../../ports/alignment-repo.js";
import type { CoreMemory } from "../memory/core-memory.js";
import type { FactStore } from "../memory/fact-store.js";

const DIGEST_SYSTEM_PROMPT =
  "You read one AI teammate's private memory and summarize it for a human " +
  "manager who is about to meet the team. Write in plain, everyday language — " +
  "no jargon, no scores, no internal variable names. Short bullets, each a " +
  "complete thought a person can skim in seconds.\n\n" +
  "Return four lists:\n" +
  "- believes: things this teammate currently takes to be true about how the " +
  "work / product / system operates. This is where a manager spots drift, so " +
  "be faithful — surface beliefs even if they sound wrong; do not correct them.\n" +
  "- knows: concrete skills and expertise it carries.\n" +
  "- working_on: what it's currently focused on.\n" +
  "- rules: hard rules or conventions it follows.\n\n" +
  "If a list has nothing, return an empty array. Never invent content that " +
  "isn't grounded in the memory provided.";

const DIGEST_MAX_TOKENS = 1200;

const DIGEST_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    believes: { type: "array", items: { type: "string" } },
    knows: { type: "array", items: { type: "string" } },
    working_on: { type: "array", items: { type: "string" } },
    rules: { type: "array", items: { type: "string" } },
  },
  required: ["believes", "knows", "working_on", "rules"],
  additionalProperties: false,
};

const EMPTY_SUMMARY: AlignmentDigestSummary = {
  believes: [],
  knows: [],
  working_on: [],
  rules: [],
};

export interface AlignmentServiceDeps {
  agentRepo: AgentRepository;
  coreMemoryRepo: CoreMemoryBlockRepository;
  memoryFactRepo: MemoryFactRepository;
  embed: EmbeddingService;
  coreMemory: CoreMemory;
  factStore: FactStore;
  meetingRepo: AlignmentMeetingRepository;
  digestRepo: AlignmentDigestRepository;
  actionRepo: AlignmentActionItemRepository;
  /**
   * The model that distills each specialist's memory. Wired to the local
   * Ollama provider (gemma) so the bulk, privacy-sensitive read stays off
   * hosted tokens.
   */
  digestLlm: LlmProvider;
}

export class TeamAgentRequiredError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} is not a team/org agent — no specialists to align`);
    this.name = "TeamAgentRequiredError";
  }
}

export class AlignmentService {
  constructor(private deps: AlignmentServiceDeps) {}

  /**
   * Start a meeting: enumerate the team agent's specialists and, for each,
   * distill its memory into a plain-language digest with the local model.
   * Returns the active meeting plus one digest per subordinate.
   */
  async prepare(
    teamAgentId: string,
    ownerPersonId: string,
  ): Promise<{ meeting: AlignmentMeeting; digests: AlignmentDigest[] }> {
    const team = await this.deps.agentRepo.findById(teamAgentId);
    if (!team) throw new Error(`Agent ${teamAgentId} not found`);
    if (team.hierarchy_level === "ic") {
      throw new TeamAgentRequiredError(teamAgentId);
    }

    const subordinates = await this.deps.agentRepo.findSubordinates(teamAgentId);

    const meeting = await this.deps.meetingRepo.create({
      id: alignmentMeetingId(),
      team_agent_id: teamAgentId,
      owner_person_id: ownerPersonId,
      status: "prepping",
    });

    const digests: AlignmentDigest[] = [];
    for (const sub of subordinates) {
      const blocks = await this.deps.coreMemoryRepo.findByAgent(sub.id);
      const facts = await this.deps.memoryFactRepo.listByAgentScope(
        sub.id,
        "ic",
        50,
      );
      const { summary, model } = await this.digestOne(sub, blocks, facts);
      const digest = await this.deps.digestRepo.create({
        id: alignmentDigestId(),
        meeting_id: meeting.id,
        agent_id: sub.id,
        summary,
        source_block_ids: blocks.map((b) => b.id),
        source_fact_ids: facts.map((f) => f.id),
        model,
      });
      digests.push(digest);
    }

    const active = await this.deps.meetingRepo.update(meeting.id, {
      status: "active",
    });
    return { meeting: active, digests };
  }

  /** Distill one specialist's memory into a plain-language card. */
  private async digestOne(
    agent: Agent,
    blocks: CoreMemoryBlock[],
    facts: MemoryFact[],
  ): Promise<{ summary: AlignmentDigestSummary; model: string }> {
    const memoryText = renderMemory(blocks, facts);
    if (memoryText.trim().length === 0) {
      return { summary: EMPTY_SUMMARY, model: this.deps.digestLlm.type };
    }

    const prompt =
      `Teammate: ${agent.name}\n` +
      `Role headline: ${blockContent(blocks, "tag_line") || "(none)"}\n\n` +
      `Here is everything in this teammate's memory:\n\n${memoryText}\n\n` +
      `Summarize it into believes / knows / working_on / rules.`;

    const { value, usage } =
      await this.deps.digestLlm.completeStructured<AlignmentDigestSummary>({
        system: DIGEST_SYSTEM_PROMPT,
        prompt,
        maxTokens: DIGEST_MAX_TOKENS,
        schema_name: "specialist_digest",
        schema_description:
          "Plain-language summary of one AI teammate's memory for a manager.",
        schema: DIGEST_SCHEMA,
      });

    return { summary: normalizeSummary(value), model: usage.model };
  }

  /**
   * Record a meeting decision. `correct_memory` items carry a target_ref; the
   * owner / team agent applies them via {@link applyActionItem}.
   */
  async createActionItem(input: {
    meetingId: string;
    agentId: string;
    kind: AlignmentActionKind;
    title: string;
    rationale?: string;
    targetRef?: AlignmentTargetRef | null;
  }): Promise<AlignmentActionItem> {
    return this.deps.actionRepo.create({
      id: alignmentActionItemId(),
      meeting_id: input.meetingId,
      agent_id: input.agentId,
      kind: input.kind,
      title: input.title,
      rationale: input.rationale ?? "",
      target_ref: input.targetRef ?? null,
      status: "open",
    });
  }

  /**
   * Apply a confirmed correction immediately — write it back into the
   * specialist's memory, then mark the item applied. `note` / `followup`
   * items just flip to applied (nothing to write).
   */
  async applyActionItem(
    itemId: string,
    appliedSessionId: string,
  ): Promise<AlignmentActionItem> {
    const item = await this.deps.actionRepo.findById(itemId);
    if (!item) throw new Error(`alignment_action_item ${itemId} not found`);
    if (item.status === "applied") return item;

    if (item.kind === "correct_memory" && item.target_ref) {
      await this.applyCorrection(item.agent_id, item.target_ref, appliedSessionId);
    }

    return this.deps.actionRepo.update(itemId, {
      status: "applied",
      applied_session_id: appliedSessionId,
      applied_at: new Date(),
    });
  }

  async dismissActionItem(itemId: string): Promise<AlignmentActionItem> {
    return this.deps.actionRepo.update(itemId, { status: "dismissed" });
  }

  /**
   * Apply a correction from within a live meeting session (the team agent's
   * `correct_subordinate_memory` MCP tool). Writes the correction back, and —
   * if the session is tied to a meeting — records it as an already-applied
   * action item for the meeting's audit trail.
   */
  async applyCorrectionForSession(input: {
    chatSessionId: string;
    agentId: string;
    targetRef: AlignmentTargetRef;
    title: string;
    rationale?: string;
  }): Promise<{ applied: true; action_item_id: string | null }> {
    const meeting = await this.deps.meetingRepo.findByChatSession(
      input.chatSessionId,
    );
    if (!meeting) {
      await this.applyCorrection(
        input.agentId,
        input.targetRef,
        input.chatSessionId,
      );
      return { applied: true, action_item_id: null };
    }
    const item = await this.createActionItem({
      meetingId: meeting.id,
      agentId: input.agentId,
      kind: "correct_memory",
      title: input.title,
      rationale: input.rationale ?? "",
      targetRef: input.targetRef,
    });
    await this.applyActionItem(item.id, input.chatSessionId);
    return { applied: true, action_item_id: item.id };
  }

  /** Write a correction back into a specialist's memory. */
  async applyCorrection(
    agentId: string,
    ref: AlignmentTargetRef,
    sessionId: string,
  ): Promise<void> {
    if (ref.type === "core_block") {
      await this.deps.coreMemory.applyUpdate(
        agentId,
        ref.block_name,
        ref.operation,
        ref.content,
        ref.old_content,
      );
      return;
    }
    // Fact correction. With a fact_id, overwrite that fact cleanly (the human
    // confirmed the fix). Without one, write a fresh corrective fact (merging
    // into a near-duplicate if one exists).
    if (ref.fact_id) {
      const embedding = await this.deps.embed.embed(ref.content);
      await this.deps.memoryFactRepo.update(ref.fact_id, {
        content: ref.content,
        embedding,
      });
      return;
    }
    await this.deps.factStore.addOrMerge(
      agentId,
      sessionId,
      ref.content,
      (ref.fact_type as FactType) ?? "belief",
      "ic",
    );
  }
}

function blockContent(blocks: CoreMemoryBlock[], name: string): string {
  return blocks.find((b) => b.block_name === name)?.content ?? "";
}

function renderMemory(blocks: CoreMemoryBlock[], facts: MemoryFact[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.content.trim().length === 0) continue;
    parts.push(`## ${b.block_name}\n${b.content.trim()}`);
  }
  if (facts.length > 0) {
    const lines = facts.map((f) => `- (${f.fact_type}) ${f.content}`).join("\n");
    parts.push(`## remembered facts\n${lines}`);
  }
  return parts.join("\n\n");
}

/** Defensive: small models sometimes return null/non-array fields. */
function normalizeSummary(value: Partial<AlignmentDigestSummary>): AlignmentDigestSummary {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    believes: arr(value.believes),
    knows: arr(value.knows),
    working_on: arr(value.working_on),
    rules: arr(value.rules),
  };
}
