import type { Metadata } from "next";
import { CommunityClient } from "./community-client";

export const metadata: Metadata = {
  title: "Community",
  description:
    "Curated design and operating patterns from teams building durable products.",
};

export default function CommunityPage() {
  return <CommunityClient />;
}
