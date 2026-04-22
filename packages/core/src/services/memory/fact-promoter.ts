import type { MemoryFact, MemoryScope } from "../../domain/memory.js";
import type { LlmProvider } from "../../ports/llm-provider.js";

export interface PromotionResult {
  /** Whether the fact should be promoted to a wider scope. */
  promoted: boolean;
  /**
   * The scope the fact should move to. Null when `promoted === false` or
   * when no valid upward target exists (org-scoped facts cannot promote further).
   */
  target_scope: MemoryScope | null;
  /** Human-readable justification for downstream auditing / debugging. */
  reason: string;
}

const PROMOTE_SYSTEM_PROMPT =
  "You evaluate whether a single memory fact, currently scoped to one agent or team, " +
  "should be promoted to a broader scope so more agents can benefit. " +
  "Promote ONLY when the fact is genuinely useful beyond its current scope — it generalizes, " +
  "is not personal to one user, and is not redundant with common knowledge. Err on keeping " +
  "narrow scope when uncertain.";

/**
 * JSON schema — target_scope uses the sentinel "none" instead of null because
 * Anthropic's strict structured-output validator rejects mixed-type enums
 * (['string', 'null'] with enum containing both strings and null). The
 * app-level code translates "none" → null when building PromotionResult.
 */
const PROMOTE_SCHEMA = {
  type: "object",
  properties: {
    promoted: {
      type: "boolean",
      description: "Whether the fact should move to a wider scope.",
    },
    target_scope: {
      type: "string",
      enum: ["team", "org", "none"],
      description:
        "The scope the fact should move to. 'none' when not promoting or when the current scope has no higher target.",
    },
    reason: {
      type: "string",
      description: "One-sentence justification for the decision.",
    },
  },
  required: ["promoted", "target_scope", "reason"],
  additionalProperties: false,
} as const;

interface RawPromotionDecision {
  promoted: boolean;
  target_scope: "team" | "org" | "none";
  reason: string;
}

const PROMOTE_MAX_TOKENS = 300;
const PROMOTE_TEMPERATURE = 0;

export interface FactPromoterDeps {
  llm: LlmProvider;
}

/**
 * FactPromoter — LLM classifier that decides whether a fact should bubble up
 * the scope hierarchy (ic → team → org). Called by MemoryAgent.onTaskComplete
 * for each fact touched during a session. The decision is a boolean + target
 * plus a short reason for audit trails.
 *
 * org-scoped facts are short-circuited to { promoted: false } without an LLM
 * call — nothing to promote them to.
 */
export class FactPromoter {
  constructor(private deps: FactPromoterDeps) {}

  async evaluate(fact: MemoryFact): Promise<PromotionResult> {
    if (fact.scope === "org") {
      return {
        promoted: false,
        target_scope: null,
        reason: "Already at org scope — no higher target.",
      };
    }

    const { value } = await this.deps.llm.completeStructured<RawPromotionDecision>({
      system: PROMOTE_SYSTEM_PROMPT,
      prompt: buildPrompt(fact),
      maxTokens: PROMOTE_MAX_TOKENS,
      temperature: PROMOTE_TEMPERATURE,
      schema_name: "promotion_decision",
      schema_description: "Decision about whether to promote a memory fact.",
      schema: PROMOTE_SCHEMA as unknown as Record<string, unknown>,
    });

    const normalizedTarget: MemoryScope | null =
      value.target_scope === "none" ? null : value.target_scope;

    // Defensive: reject promotions that would not actually widen the scope.
    if (value.promoted && !isValidUpward(fact.scope, normalizedTarget)) {
      return {
        promoted: false,
        target_scope: null,
        reason: `LLM proposed invalid promotion ${fact.scope} → ${value.target_scope}; skipping.`,
      };
    }

    return {
      promoted: value.promoted,
      target_scope: normalizedTarget,
      reason: value.reason,
    };
  }
}

function buildPrompt(fact: MemoryFact): string {
  return [
    `Fact content: ${fact.content}`,
    `Fact type: ${fact.fact_type}`,
    `Current scope: ${fact.scope}`,
    "",
    "Decide whether to promote this fact. If the content is personal to one",
    "agent, an idiosyncratic detail, or already covered by common knowledge,",
    "keep the narrower scope. If it represents a durable pattern, convention,",
    "or decision that would help sibling agents, promote up one level.",
  ].join("\n");
}

function isValidUpward(
  current: MemoryScope,
  target: MemoryScope | null,
): boolean {
  if (target === null) return false;
  if (current === "ic") return target === "team" || target === "org";
  if (current === "team") return target === "org";
  return false;
}
