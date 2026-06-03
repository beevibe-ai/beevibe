import type { Metadata } from "next";
import { AlignmentClient } from "./alignment-client";

export const metadata: Metadata = { title: "Alignment" };

export default function AlignmentPage() {
  return <AlignmentClient />;
}
