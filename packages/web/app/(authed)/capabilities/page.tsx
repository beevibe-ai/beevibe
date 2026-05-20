import type { Metadata } from "next";
import { CapabilitiesClient } from "./capabilities-client";

export const metadata: Metadata = { title: "Capabilities" };

export default function CapabilitiesPage() {
  return <CapabilitiesClient />;
}
