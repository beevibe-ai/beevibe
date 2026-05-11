"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, KeyRound, Loader2, LogIn } from "lucide-react";
import { SIGNIN_NO_PASSWORD_SET } from "@beevibe/core/auth/constants";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/http";
import {
  getUserKey,
  isApiConfigured,
  isWellFormedUserKey,
  setUserKey,
} from "@/lib/api/config";

type Mode = "password" | "key";

/**
 * Two ways to sign in:
 *
 *   1. Email + password (default). New since the password migration.
 *      Server matches the password against `person.password_hash` and
 *      returns the user's `bv_u_` key on success.
 *
 *   2. Paste your `bv_u_` key (fallback). For legacy / seeded users
 *      who predate passwords, plus power users who already have the
 *      key from `pnpm provision-user`. After signing in via paste,
 *      they can set a password by re-signing-up with the same email.
 *
 * In both cases the bv_u_ key is the actual session token. The
 * password is just a way to *retrieve* the key without having to
 * remember it.
 */
export function SignInClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams?.get("next") ?? "/";

  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Skip the form if a key is already cached.
  useEffect(() => {
    if (getUserKey()) router.replace(next);
  }, [next, router]);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isApiConfigured) {
      setError("Web isn't configured to talk to an api server.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.signin.create({
        email: email.trim().toLowerCase(),
        password,
      });
      setUserKey(res.api_key);
      router.replace(next);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      const body =
        err instanceof ApiError ? (err.body as { error?: string; message?: string } | undefined) : undefined;
      // Friendly fallback for legacy users whose accounts predate
      // passwords — push them to the paste-key path.
      if (status === 409 && body?.error === SIGNIN_NO_PASSWORD_SET) {
        setMode("key");
        setError(
          body.message ??
            "This account predates passwords — sign in with your bv_u_ key once, then re-sign-up to set a password.",
        );
      } else if (status === 401) {
        setError("Email or password is incorrect.");
      } else {
        setError(body?.message ?? `Couldn't sign you in — ${(err as Error).message}`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const submitKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isApiConfigured) {
      setError("Web isn't configured to talk to an api server.");
      return;
    }
    const key = keyDraft.trim();
    if (!isWellFormedUserKey(key)) {
      setError("That doesn't look like a bv_u_ key. Format: bv_u_<letters/digits>.");
      return;
    }
    setError(null);
    setSubmitting(true);
    setUserKey(key);
    try {
      await api.me.self();
      router.replace(next);
    } catch (err) {
      window.localStorage.removeItem("bv:user_key");
      const status = err instanceof ApiError ? err.status : undefined;
      setError(
        status === 401
          ? "Key wasn't recognized. Double-check it or ask your admin to provision a new one."
          : `Couldn't verify the key — ${(err as Error).message}`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-6 bg-background">
      <form
        onSubmit={mode === "password" ? submitPassword : submitKey}
        className="w-full max-w-sm bg-card border border-border rounded-lg p-6 shadow-sm"
      >
        <header className="mb-5">
          <div className="inline-flex items-center justify-center h-10 w-10 rounded-md bg-primary text-primary-foreground mb-3">
            {mode === "password" ? (
              <LogIn className="h-5 w-5" />
            ) : (
              <KeyRound className="h-5 w-5" />
            )}
          </div>
          <h1 className="text-lg font-semibold tracking-tight">Sign in to beevibe</h1>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            {mode === "password" ? (
              <>Email + password. Your <span className="font-mono">bv_u_</span> key is generated server-side and never leaves the browser after.</>
            ) : (
              <>Paste your <span className="font-mono">bv_u_</span> key — for legacy accounts or CLI-provisioned users.</>
            )}
          </p>
        </header>

        {mode === "password" ? (
          <>
            <label className="block text-xs font-medium text-foreground mb-1.5" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              autoFocus
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
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              disabled={submitting}
            />
          </>
        ) : (
          <>
            <label className="block text-xs font-medium text-foreground mb-1.5" htmlFor="key">
              User API key
            </label>
            <input
              id="key"
              type="password"
              autoComplete="off"
              autoFocus
              spellCheck={false}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="bv_u_..."
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              disabled={submitting}
            />
          </>
        )}

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
            (mode === "password"
              ? email.trim().length === 0 || password.length === 0
              : keyDraft.trim().length === 0)
          }
          className="mt-5 w-full inline-flex items-center justify-center gap-1.5 h-9 rounded text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {mode === "password" ? "Signing in…" : "Verifying…"}
            </>
          ) : (
            <>
              <LogIn className="h-3.5 w-3.5" />
              Sign in
            </>
          )}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode((m) => (m === "password" ? "key" : "password"));
            setError(null);
          }}
          disabled={submitting}
          className="mt-3 w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
        >
          {mode === "password"
            ? "Or sign in with your bv_u_ key"
            : "Or sign in with email + password"}
        </button>

        <footer className="mt-5 pt-4 border-t border-border/60 text-[11px] text-muted-foreground leading-relaxed">
          New here?{" "}
          <Link href="/sign-up" className="text-foreground/80 hover:underline">
            Sign up
          </Link>{" "}
          — takes about 5 seconds.
        </footer>
      </form>
    </main>
  );
}
