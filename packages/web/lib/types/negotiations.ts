// Serialized negotiation review shape returned by GET /negotiation/:id.
// Mirrors @beevibe/core's NegotiationReview but with timestamps as ISO
// strings — the web only sees JSON over the wire.

import type { NegotiationRound, NegotiationReview } from "@beevibe/core";

export type { NegotiationStatus, NegotiationDecision } from "@beevibe/core";

export type NegotiationRoundDetail = Omit<NegotiationRound, "sent_at"> & {
  sent_at: string;
};

export type NegotiationReviewDetail = Omit<
  NegotiationReview,
  "rounds" | "created_at" | "updated_at"
> & {
  rounds: NegotiationRoundDetail[];
  created_at: string;
  updated_at: string;
};
