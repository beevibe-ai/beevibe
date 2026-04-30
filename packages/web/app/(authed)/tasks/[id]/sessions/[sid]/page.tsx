import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = { title: "Session" };

export default function SessionDetailPage(_props: {
  params: { id: string; sid: string };
}) {
  notFound();
}
