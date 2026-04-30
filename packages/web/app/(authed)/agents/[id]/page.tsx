import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = { title: "Agent" };

export default function AgentDetailPage(_props: { params: { id: string } }) {
  notFound();
}
