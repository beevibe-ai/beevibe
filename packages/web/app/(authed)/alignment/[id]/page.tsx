import type { Metadata } from "next";
import { MeetingRoomClient } from "./meeting-room-client";

export const metadata: Metadata = { title: "Alignment meeting" };

export default function MeetingRoomPage({ params }: { params: { id: string } }) {
  return <MeetingRoomClient meetingId={params.id} />;
}
