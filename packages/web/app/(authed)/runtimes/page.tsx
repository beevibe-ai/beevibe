import type { Metadata } from "next";
import { RuntimesClient } from "./runtimes-client";

export const metadata: Metadata = { title: "Runtimes" };
export const dynamic = "force-dynamic";

export default function RuntimesPage() {
  return <RuntimesClient />;
}
