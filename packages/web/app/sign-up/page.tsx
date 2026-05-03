import type { Metadata } from "next";
import { SignUpClient } from "./sign-up-client";

export const metadata: Metadata = { title: "Sign up" };
export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return <SignUpClient />;
}
