import type { Metadata } from "next";
import { NegotiationDetailClient } from "./negotiation-detail-client";

export const metadata: Metadata = { title: "Negotiation" };

export default function NegotiationDetailPage({ params }: { params: { id: string } }) {
  return <NegotiationDetailClient negotiationId={params.id} />;
}
