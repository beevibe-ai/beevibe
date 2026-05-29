import type { NegotiationReview } from "../domain/negotiation.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { EscalationRepository } from "../ports/escalation-repo.js";
import type {
  NegotiationRepository,
  NegotiationRoundRepository,
} from "../ports/negotiation-repo.js";
import { NegotiationNotFoundError } from "./escalation-service.js";

export { NegotiationNotFoundError };

export interface NegotiationServiceDeps {
  negotiationRepo: NegotiationRepository;
  negotiationRoundRepo: NegotiationRoundRepository;
  agentRepo: AgentRepository;
  escalationRepo: EscalationRepository;
}

/**
 * Read-only service for the human-facing negotiation review page. Fetches
 * the row, its full round transcript, both agent display names, and the
 * linked escalation id (when escalated) — all in parallel.
 */
export class NegotiationService {
  constructor(private readonly deps: NegotiationServiceDeps) {}

  async getReview(id: string): Promise<NegotiationReview> {
    const neg = await this.deps.negotiationRepo.findById(id);
    if (!neg) throw new NegotiationNotFoundError(id);

    const [initiatorAgent, counterpartyAgent, rounds, escalation] = await Promise.all([
      this.deps.agentRepo.findById(neg.initiator_agent_id),
      this.deps.agentRepo.findById(neg.counterparty_agent_id),
      this.deps.negotiationRoundRepo.listByNegotiation(neg.id),
      this.deps.escalationRepo.findByNegotiation(neg.id),
    ]);

    return {
      ...neg,
      initiator_agent_name: initiatorAgent?.name ?? neg.initiator_agent_id,
      counterparty_agent_name: counterpartyAgent?.name ?? neg.counterparty_agent_id,
      rounds,
      escalation_id: escalation?.id,
    };
  }
}
