"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Sparkles, UserPlus } from "lucide-react";
import { PASSWORD_MIN_LENGTH } from "@beevibe/core/auth/constants";
import { api } from "@/lib/api/client";
import { asApiError } from "@/lib/api/http";
import { getUserKey, isApiConfigured, setUserKey } from "@/lib/api/config";
import { AuthCard, AuthError, AuthField, AuthSubmitButton } from "@/components/auth/auth-form";

/**
 * Self-serve signup. Visitor enters name + email; the api mints them a
 * person + their primary team agent + a bv_u_ key, which we persist to
 * localStorage and route them through `/welcome` (so they land on the
 * onboarding chat with `from=welcome`).
 *
 * Idempotent: existing email → returns the existing person's key, so
 * users who lost their key can recover by signing up again.
 */
export function SignUpClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Invite-link flow: `?room=room_xxx&email=...` pre-fills the email,
  // and on success the new visitor auto-joins that room (which puts
  // their team agent in too) and lands there instead of /welcome.
  const inviteRoomId = searchParams?.get("room") ?? null;
  const inviteEmail = searchParams?.get("email") ?? "";

  const [name, setName] = useState("");
  const [email, setEmail] = useState(inviteEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // If they already have a stored key, skip the form.
  useEffect(() => {
    if (getUserKey()) router.replace(inviteRoomId ? `/rooms/${inviteRoomId}` : "/");
  }, [router, inviteRoomId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isApiConfigured) {
      setError("Web isn't configured to talk to an api server.");
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.signup.create({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      setUserKey(res.api_key);
      // If this was an invite-link flow, the new user joins the target
      // room directly (URL = bearer of trust). Their team agent gets
      // added alongside. Best-effort: failure here doesn't block the
      // happy path of just landing on /welcome.
      if (inviteRoomId) {
        try {
          await api.rooms.join(inviteRoomId);
          router.replace(`/rooms/${inviteRoomId}`);
          return;
        } catch {
          // Fall through to /welcome and let the user discover the room
          // manually if /join failed (e.g. room was deleted).
        }
      }
      // New visitors land in the onboarding chat; returning visitors
      // (existed=true) might already be past onboarding — in either
      // case `/welcome` does the right thing via /me's needs_onboarding.
      router.replace(res.existed ? "/" : "/welcome");
    } catch (err) {
      const apiErr = asApiError(err);
      setError(
        apiErr?.status === 404
          ? "Sign-up isn't enabled on this server. Ask the admin to provision a key for you."
          : apiErr?.serverMessage ?? `Couldn't sign you up — ${(err as Error).message}`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      icon={UserPlus}
      title="Sign up for beevibe"
      description={
        <>
          We&apos;ll mint you a personal team agent. Your key stays in your browser only — you
          can come back and sign in with the same email later.
        </>
      }
      onSubmit={submit}
      footer={
        <>
          Already have a key?{" "}
          <Link href="/sign-in" className="text-foreground/80 hover:underline">
            Sign in
          </Link>{" "}
          instead.
        </>
      }
    >
      <AuthField
        first
        id="name"
        label="Name"
        type="text"
        autoComplete="name"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Alice"
        disabled={submitting}
      />

      <AuthField
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        inputMode="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="alice@example.com"
        disabled={submitting}
      />

      <AuthField
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={`at least ${PASSWORD_MIN_LENGTH} characters`}
        disabled={submitting}
      />

      <AuthError message={error} />

      <AuthSubmitButton
        icon={Sparkles}
        label="Create my team agent"
        pendingLabel="Provisioning…"
        pending={submitting}
        disabled={
          submitting ||
          name.trim().length === 0 ||
          email.trim().length === 0 ||
          password.length < PASSWORD_MIN_LENGTH
        }
      />
    </AuthCard>
  );
}
