import type { Metadata } from "next";
import { AgentDetailClient } from "./agent-detail-client";

export const metadata: Metadata = { title: "Agent" };

export default function AgentDetailPage({ params }: { params: { id: string } }) {
  return <AgentDetailClient agentId={params.id} />;
}
