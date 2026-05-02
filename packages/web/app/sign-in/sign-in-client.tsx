"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, KeyRound, Loader2, LogIn } from "lucide-react";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/http";
import {
  getUserKey,
  isApiConfigured,
  isWellFormedUserKey,
  setUserKey,
} from "@/lib/api/config";

/**
 * Paste-key sign-in. The visitor receives a `bv_u_<...>` key
 * out-of-band (admin runs `pnpm provision-user --name … --email …`)
 * and pastes it here. We POST against `/me` to validate; on success
 * the key persists in localStorage and the visitor is redirected to
 * the page they came from (or `/` by default).
 *
 * The key is browser-local — never sent to anywhere but the configured
 * api server, never embedded in the JS bundle. Sign-out clears it.
 */
export function SignInClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams?.get("next") ?? "/";

  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // If a key is already stored (browser cache from a prior session),
  // skip the form and bounce. The AuthGate would do this too, but
  // skipping the render avoids a flash of the form.
  useEffect(() => {
    if (getUserKey()) router.replace(next);
  }, [next, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isApiConfigured) {
      setError("Web isn't configured to talk to an api server.");
      return;
    }
    const key = draft.trim();
    if (!isWellFormedUserKey(key)) {
      setError("That doesn't look like a bv_u_ key. Format: bv_u_<letters/digits>.");
      return;
    }
    setError(null);
    setSubmitting(true);

    // Stash the key first so the validation request itself uses it.
    setUserKey(key);
    try {
      await api.me.self();
      router.replace(next);
    } catch (err) {
      // Roll back the key on failure so the AuthGate doesn't bounce
      // back-and-forth.
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
        onSubmit={submit}
        className="w-full max-w-sm bg-card border border-border rounded-lg p-6 shadow-sm"
      >
        <header className="mb-5">
          <div className="inline-flex items-center justify-center h-10 w-10 rounded-md bg-primary text-primary-foreground mb-3">
            <KeyRound className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">Sign in to beevibe</h1>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            Paste your <span className="font-mono">bv_u_</span> key. It stays in your browser —
            we don&apos;t send it anywhere except the api server.
          </p>
        </header>

        <label className="block text-xs font-medium text-foreground mb-1.5" htmlFor="key">
          User API key
        </label>
        <input
          id="key"
          type="password"
          autoComplete="off"
          autoFocus
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="bv_u_..."
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
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
          disabled={submitting || draft.trim().length === 0}
          className="mt-5 w-full inline-flex items-center justify-center gap-1.5 h-9 rounded text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Verifying…
            </>
          ) : (
            <>
              <LogIn className="h-3.5 w-3.5" />
              Sign in
            </>
          )}
        </button>

        <footer className="mt-5 pt-4 border-t border-border/60 text-[11px] text-muted-foreground leading-relaxed">
          Don&apos;t have a key? Ask your admin to run{" "}
          <span className="font-mono text-foreground/80">pnpm provision-user</span> with your
          name + email.
        </footer>
      </form>
    </main>
  );
}
