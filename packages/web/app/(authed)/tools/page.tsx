import type { Metadata } from "next";
import { ToolsClient } from "./tools-client";

export const metadata: Metadata = { title: "Tools" };

export default function ToolsPage() {
  return <ToolsClient />;
}
