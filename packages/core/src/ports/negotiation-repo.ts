import type {
  Negotiation,
  NegotiationDecision,
  NegotiationRound,
  NegotiationStatus,
} from "../domain/negotiation.js";

export type NewNegotiation = Omit<
  Negotiation,
  "rounds_completed" | "status" | "created_at" | "updated_at"
> & {
  rounds_completed?: number;
  status?: NegotiationStatus;
};

export interface NegotiationPatch {
  status?: NegotiationStatus;
  counterparty_session_id?: string;
  /** Bumps `rounds_completed` to this exact value (not delta). */
  rounds_completed?: number;
}

export interface NegotiationRepository {
  findById(id: string): Promise<Negotiation | undefined>;
  /** Find an active negotiation between (initiator, counterparty), if any. */
  findActiveBetween(
    initiatorAgentId: string,
    counterpartyAgentId: string,
  ): Promise<Negotiation | undefined>;
  create(input: NewNegotiation): Promise<Negotiation>;
  update(id: string, patch: NegotiationPatch): Promise<Negotiation>;
}

export type NewNegotiationRound = Omit<NegotiationRound, "sent_at">;

export interface NegotiationRoundRepository {
  /** All rounds for a negotiation, oldest first. */
  listByNegotiation(negotiationId: string): Promise<NegotiationRound[]>;
  /** Most recent round (highest round_number). */
  findLatest(negotiationId: string): Promise<NegotiationRound | undefined>;
  create(input: NewNegotiationRound): Promise<NegotiationRound>;
}

// Helper for ergonomic round-decision filtering by callers.
export type _RoundDecisionFilter = NegotiationDecision;
