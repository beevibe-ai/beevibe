import type { Metadata } from "next";
import { MeshClient } from "./mesh-client";

export const metadata: Metadata = { title: "Mesh" };

export default function MeshPage() {
  return <MeshClient />;
}
