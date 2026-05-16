import type { Metadata } from "next";
import { RunDetailClient } from "./run-detail-client";

export const metadata: Metadata = { title: "Run" };

export default function RunDetailPage({ params }: { params: { id: string } }) {
  return <RunDetailClient id={params.id} />;
}
