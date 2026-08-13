"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { KeyRound, LogIn } from "lucide-react";
import { SIGNIN_NO_PASSWORD_SET } from "@beevibe/core/auth/constants";
import { api } from "@/lib/api/client";
import { asApiError } from "@/lib/api/http";
import {
  getUserKey,
  isApiConfigured,
  isWellFormedUserKey,
  setUserKey,
} from "@/lib/api/config";
import { AUTH_API_NOT_CONFIGURED, AuthCard, AuthField } from "@/components/auth/auth-card";

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
      setError(AUTH_API_NOT_CONFIGURED);
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
      const apiErr = asApiError(err);
      // Friendly fallback for legacy users whose accounts predate
      // passwords — push them to the paste-key path.
      if (apiErr?.status === 409 && apiErr.errorCode === SIGNIN_NO_PASSWORD_SET) {
        setMode("key");
        setError(
          apiErr.serverMessage ??
            "This account predates passwords — sign in with your bv_u_ key once, then re-sign-up to set a password.",
        );
      } else if (apiErr?.status === 401) {
        setError("Email or password is incorrect.");
      } else {
        setError(apiErr?.serverMessage ?? `Couldn't sign you in — ${(err as Error).message}`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const submitKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isApiConfigured) {
      setError(AUTH_API_NOT_CONFIGURED);
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
      setError(
        asApiError(err)?.status === 401
          ? "Key wasn't recognized. Double-check it or ask your admin to provision a new one."
          : `Couldn't verify the key — ${(err as Error).message}`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const passwordMode = mode === "password";

  return (
    <AuthCard
      icon={passwordMode ? LogIn : KeyRound}
      title="Sign in to beevibe"
      blurb={
        passwordMode ? (
          <>
            Email + password. Your <span className="font-mono">bv_u_</span> key is generated
            server-side and never leaves the browser after.
          </>
        ) : (
          <>
            Paste your <span className="font-mono">bv_u_</span> key — for legacy accounts or
            CLI-provisioned users.
          </>
        )
      }
      onSubmit={passwordMode ? submitPassword : submitKey}
      error={error}
      submit={{
        label: "Sign in",
        icon: LogIn,
        pendingLabel: passwordMode ? "Signing in…" : "Verifying…",
        pending: submitting,
        disabled: passwordMode
          ? email.trim().length === 0 || password.length === 0
          : keyDraft.trim().length === 0,
      }}
      secondary={
        <button
          type="button"
          onClick={() => {
            setMode((m) => (m === "password" ? "key" : "password"));
            setError(null);
          }}
          disabled={submitting}
          className="mt-3 w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
        >
          {passwordMode
            ? "Or sign in with your bv_u_ key"
            : "Or sign in with email + password"}
        </button>
      }
      footer={
        <>
          New here?{" "}
          <Link href="/sign-up" className="text-foreground/80 hover:underline">
            Sign up
          </Link>{" "}
          — takes about 5 seconds.
        </>
      }
    >
      {passwordMode ? (
        <>
          <AuthField
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
            value={email}
            onChange={setEmail}
            placeholder="alice@example.com"
            disabled={submitting}
          />
          <AuthField
            id="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            placeholder="••••••••"
            disabled={submitting}
            spaced
          />
        </>
      ) : (
        <AuthField
          id="key"
          label="User API key"
          type="password"
          autoComplete="off"
          autoFocus
          spellCheck={false}
          value={keyDraft}
          onChange={setKeyDraft}
          placeholder="bv_u_..."
          disabled={submitting}
          inputClassName="font-mono"
        />
      )}
    </AuthCard>
  );
}
