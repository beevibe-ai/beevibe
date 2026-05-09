import type { Metadata } from "next";
import { RoomsListClient } from "./rooms-list-client";

export const metadata: Metadata = { title: "Rooms" };
export const dynamic = "force-dynamic";

export default function RoomsPage() {
  return <RoomsListClient />;
}
