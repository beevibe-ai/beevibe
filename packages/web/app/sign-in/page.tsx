import type { Metadata } from "next";
import { SignInClient } from "./sign-in-client";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default function SignInPage() {
  return <SignInClient />;
}
