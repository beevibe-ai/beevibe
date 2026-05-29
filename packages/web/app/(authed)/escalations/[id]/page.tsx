import type { Metadata } from "next";
import { EscalationDetailClient } from "./escalation-detail-client";

export const metadata: Metadata = { title: "Escalation" };

export default function EscalationDetailPage({ params }: { params: { id: string } }) {
  return <EscalationDetailClient escalationId={params.id} />;
}
