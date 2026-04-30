import type { Metadata } from "next";
import { ThreadsClient } from "./threads-client";

export const metadata: Metadata = { title: "Threads" };

export default function ThreadsPage() {
  return <ThreadsClient />;
}
