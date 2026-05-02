import type { Metadata } from "next";
import { WelcomeClient } from "./welcome-client";

export const metadata: Metadata = { title: "Welcome" };
export const dynamic = "force-dynamic";

export default function WelcomePage() {
  return <WelcomeClient />;
}
