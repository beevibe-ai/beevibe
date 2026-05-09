import type { Metadata } from "next";
import { ChatSessionDetailClient } from "./chat-session-detail-client";

export const metadata: Metadata = { title: "Session" };

export default function ChatSessionDetailPage({
  params,
}: {
  params: { sid: string };
}) {
  return <ChatSessionDetailClient sessionShortId={params.sid} />;
}
