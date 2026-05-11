"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Loader2, Sparkles, UserPlus } from "lucide-react";
import { PASSWORD_MIN_LENGTH } from "@beevibe/core/auth/constants";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/http";
import { getUserKey, isApiConfigured, setUserKey } from "@/lib/api/config";

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
      const status = err instanceof ApiError ? err.status : undefined;
      const body = err instanceof ApiError ? (err.body as { message?: string } | undefined) : undefined;
      setError(
        status === 404
          ? "Sign-up isn't enabled on this server. Ask the admin to provision a key for you."
          : body?.message ?? `Couldn't sign you up — ${(err as Error).message}`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-6 bg-background">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-card border border-border rounded-lg p-6 shadow-sm"
      >
        <header className="mb-5">
          <div className="inline-flex items-center justify-center h-10 w-10 rounded-md bg-primary text-primary-foreground mb-3">
            <UserPlus className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">Sign up for beevibe</h1>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            We&apos;ll mint you a personal team agent. Your key stays in your browser only — you
            can come back and sign in with the same email later.
          </p>
        </header>

        <label className="block text-xs font-medium text-foreground mb-1.5" htmlFor="name">
          Name
        </label>
        <input
          id="name"
          type="text"
          autoComplete="name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Alice"
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={submitting}
        />

        <label className="block text-xs font-medium text-foreground mb-1.5 mt-3" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="alice@example.com"
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={submitting}
        />

        <label className="block text-xs font-medium text-foreground mb-1.5 mt-3" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={`at least ${PASSWORD_MIN_LENGTH} characters`}
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={submitting}
        />

        {error ? (
          <div className="mt-3 flex items-start gap-1.5 text-xs text-status-failed">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <button
          type="submit"
          disabled={
            submitting ||
            name.trim().length === 0 ||
            email.trim().length === 0 ||
            password.length < PASSWORD_MIN_LENGTH
          }
          className="mt-5 w-full inline-flex items-center justify-center gap-1.5 h-9 rounded text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Provisioning…
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              Create my team agent
            </>
          )}
        </button>

        <footer className="mt-5 pt-4 border-t border-border/60 text-[11px] text-muted-foreground leading-relaxed">
          Already have a key?{" "}
          <Link href="/sign-in" className="text-foreground/80 hover:underline">
            Sign in
          </Link>{" "}
          instead.
        </footer>
      </form>
    </main>
  );
}
