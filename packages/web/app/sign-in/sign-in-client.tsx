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
import {
  AuthCard,
  AuthError,
  AuthField,
  AuthSubmitButton,
} from "@/components/auth/auth-form";

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
      setError(
        asApiError(err)?.status === 401
          ? "Key wasn't recognized. Double-check it or ask your admin to provision a new one."
          : `Couldn't verify the key — ${(err as Error).message}`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      icon={mode === "password" ? LogIn : KeyRound}
      title="Sign in to beevibe"
      blurb={
        mode === "password" ? (
          <>Email + password. Your <span className="font-mono">bv_u_</span> key is generated server-side and never leaves the browser after.</>
        ) : (
          <>Paste your <span className="font-mono">bv_u_</span> key — for legacy accounts or CLI-provisioned users.</>
        )
      }
      onSubmit={mode === "password" ? submitPassword : submitKey}
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
      {mode === "password" ? (
        <>
          <AuthField
            first
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="alice@example.com"
            disabled={submitting}
          />

          <AuthField
            id="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            disabled={submitting}
          />
        </>
      ) : (
        <AuthField
          first
          id="key"
          label="User API key"
          type="password"
          autoComplete="off"
          autoFocus
          spellCheck={false}
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          placeholder="bv_u_..."
          className="font-mono"
          disabled={submitting}
        />
      )}

      <AuthError message={error} />

      <AuthSubmitButton
        icon={LogIn}
        label="Sign in"
        pendingLabel={mode === "password" ? "Signing in…" : "Verifying…"}
        pending={submitting}
        disabled={
          mode === "password"
            ? email.trim().length === 0 || password.length === 0
            : keyDraft.trim().length === 0
        }
      />

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
    </AuthCard>
  );
}
