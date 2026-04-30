import type { Metadata } from "next";
import { AgentsClient } from "./agents-client";

export const metadata: Metadata = { title: "Agents" };

export default function AgentsPage() {
  return <AgentsClient />;
}
