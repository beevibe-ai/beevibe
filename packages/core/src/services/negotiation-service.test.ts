import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../domain/agent.js";
import type { Escalation } from "../domain/escalation.js";
import type { Negotiation, NegotiationRound } from "../domain/negotiation.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { EscalationRepository } from "../ports/escalation-repo.js";
import type {
  NegotiationRepository,
  NegotiationRoundRepository,
} from "../ports/negotiation-repo.js";
import { NegotiationNotFoundError, NegotiationService } from "./negotiation-service.js";

function makeNeg(overrides: Partial<Negotiation> = {}): Negotiation {
  return {
    id: "neg_1",
    initiator_agent_id: "agent_a",
    initiator_session_id: "sess_a",
    counterparty_agent_id: "agent_b",
    counterparty_session_id: "sess_b",
    task_id: "task_1",
    max_rounds: 5,
    rounds_completed: 2,
    status: "active",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeRound(overrides: Partial<NegotiationRound> = {}): NegotiationRound {
  return {
    id: "round_1",
    negotiation_id: "neg_1",
    round_number: 1,
    from_agent_id: "agent_a",
    decision: "propose",
    message: "round message",
    sent_at: new Date(),
    ...overrides,
  };
}

let negotiationRepo: NegotiationRepository;
let negotiationRoundRepo: NegotiationRoundRepository;
let agentRepo: AgentRepository;
let escalationRepo: EscalationRepository;
let svc: NegotiationService;

beforeEach(() => {
  negotiationRepo = {
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  negotiationRoundRepo = {
    listByNegotiation: vi.fn(),
    create: vi.fn(),
  };
  agentRepo = {
    findById: vi.fn(),
    findByApiKey: vi.fn(),
    findTopLevelForOwner: vi.fn(),
    findSubordinates: vi.fn(),
    findPeers: vi.fn(),
    findParent: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  escalationRepo = {
    findById: vi.fn(),
    findByNegotiation: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  svc = new NegotiationService({
    negotiationRepo,
    negotiationRoundRepo,
    agentRepo,
    escalationRepo,
  });

  vi.mocked(agentRepo.findById).mockImplementation(
    async (id: string) =>
      ({
        id,
        name: id === "agent_a" ? "Alice team" : id === "agent_b" ? "Bob team" : id,
      }) as unknown as Agent,
  );
});

describe("NegotiationService.getReview", () => {
  it("returns rounds + agent names; no escalation when not escalated", async () => {
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg({ status: "active" }));
    vi.mocked(negotiationRoundRepo.listByNegotiation).mockResolvedValue([
      makeRound({ round_number: 1, from_agent_id: "agent_a", decision: "propose", message: "A1" }),
      makeRound({ id: "round_2", round_number: 2, from_agent_id: "agent_b", decision: "counter", message: "B1" }),
    ]);
    vi.mocked(escalationRepo.findByNegotiation).mockResolvedValue(undefined);

    const review = await svc.getReview("neg_1");

    expect(review.initiator_agent_name).toBe("Alice team");
    expect(review.counterparty_agent_name).toBe("Bob team");
    expect(review.rounds).toHaveLength(2);
    expect(review.rounds[0]?.message).toBe("A1");
    expect(review.escalation_id).toBeUndefined();
    expect(review.status).toBe("active");
  });

  it("includes escalation_id when the negotiation was escalated", async () => {
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg({ status: "escalated" }));
    vi.mocked(negotiationRoundRepo.listByNegotiation).mockResolvedValue([]);
    vi.mocked(escalationRepo.findByNegotiation).mockResolvedValue(
      { id: "esc_1" } as unknown as Escalation,
    );

    const review = await svc.getReview("neg_1");

    expect(review.escalation_id).toBe("esc_1");
    expect(review.status).toBe("escalated");
  });

  it("falls back to the agent id when an agent was deleted", async () => {
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(negotiationRoundRepo.listByNegotiation).mockResolvedValue([]);
    vi.mocked(escalationRepo.findByNegotiation).mockResolvedValue(undefined);
    vi.mocked(agentRepo.findById).mockResolvedValue(undefined);

    const review = await svc.getReview("neg_1");

    expect(review.initiator_agent_name).toBe("agent_a");
    expect(review.counterparty_agent_name).toBe("agent_b");
  });

  it("throws NegotiationNotFoundError for a missing negotiation", async () => {
    vi.mocked(negotiationRepo.findById).mockResolvedValue(undefined);
    await expect(svc.getReview("neg_missing")).rejects.toThrow(NegotiationNotFoundError);
  });
});
