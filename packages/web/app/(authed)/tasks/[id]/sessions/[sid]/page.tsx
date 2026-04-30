import type { Metadata } from "next";
import { SessionDetailClient } from "./session-detail-client";

export const metadata: Metadata = { title: "Session" };

export default function SessionDetailPage({
  params,
}: {
  params: { id: string; sid: string };
}) {
  return <SessionDetailClient taskId={params.id} sessionShortId={params.sid} />;
}
