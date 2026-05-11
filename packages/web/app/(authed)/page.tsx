import type { Metadata } from "next";
import { ChatClient } from "./chat/chat-client";

export const metadata: Metadata = { title: "Chat" };
export const dynamic = "force-dynamic";

export default function HomePage() {
  return <ChatClient />;
}
