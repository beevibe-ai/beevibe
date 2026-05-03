import type { Metadata } from "next";
import { RoomDetailClient } from "./room-detail-client";

export const metadata: Metadata = { title: "Room" };
export const dynamic = "force-dynamic";

export default function RoomDetailPage({ params }: { params: { id: string } }) {
  return <RoomDetailClient roomId={params.id} />;
}
