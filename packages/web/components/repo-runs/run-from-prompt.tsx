"use client";

import { useState } from "react";
import { Loader2, PlayCircle, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Free-form "Run a repo" form. Primary path on `/tools`: type a repo
 * URL and a goal, optionally a sample input, hit Run in sandbox. The
 * parent wires `onLaunch` to POST to `/api/tools/use-repo` and surface
 * the run id back as a LiveRunCard.
 *
 * No discovery, no ranking, no fixture coupling — proves the
 * sandbox primitive is general, not a hardcoded pdfplumber demo.
 */
export function RunFromPromptForm({
  onLaunch,
}: {
  onLaunch: (input: {
    repo_url: string;
    goal: string;
    input_url?: string;
    input_filename?: string;
  }) => Promise<string | null>;
}) {
  const [repoUrl, setRepoUrl] = useState("");
  const [goal, setGoal] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [inputFilename, setInputFilename] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repoLooksValid =
    /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/i.test(repoUrl.trim());
  const goalLooksValid = goal.trim().length > 0;
  const inputUrlLooksValid =
    inputUrl.trim().length === 0 ||
    /^https?:\/\//i.test(inputUrl.trim());
  const canSubmit =
    repoLooksValid && goalLooksValid && inputUrlLooksValid && !submitting;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const run_id = await onLaunch({
        repo_url: repoUrl.trim(),
        goal: goal.trim(),
        input_url: inputUrl.trim() || undefined,
        input_filename:
          inputFilename.trim() ||
          (inputUrl.trim() ? deriveFilename(inputUrl.trim()) : undefined),
      });
      if (run_id) {
        // Clear the goal so it's clear we accepted, but keep the repo
        // URL so the user can iterate with a different goal.
        setGoal("");
        setInputUrl("");
        setInputFilename("");
      } else {
        setError("Couldn't start the run. Check the server logs.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3">
        <h2 className="text-sm font-medium leading-tight mb-1">Run a repo</h2>
        <p className="text-xs text-muted-foreground">
          Point at a GitHub repo and tell the agent what to do with it. We&apos;ll
          clone it inside a sandbox, install what&apos;s needed, run it, and bring
          back the artifact.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-3">
        <div>
          <label
            htmlFor="repo-url"
            className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-medium"
          >
            Repo URL
          </label>
          <input
            id="repo-url"
            type="url"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/jsvine/pdfplumber"
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {repoUrl.length > 0 && !repoLooksValid ? (
            <p className="mt-1 text-[11px] text-status-failed inline-flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              Needs to look like https://github.com/&lt;owner&gt;/&lt;repo&gt;
            </p>
          ) : null}
        </div>

        <div>
          <label
            htmlFor="run-goal"
            className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-medium"
          >
            Goal
          </label>
          <textarea
            id="run-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Extract the tables from tests/pdfs/federal-register-2020-17221.pdf into JSON."
            rows={3}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-y"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Describe the outcome you want, in one or two sentences. The agent
            reads the repo&apos;s README to figure out the install + invocation.
          </p>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            {advancedOpen ? "Hide" : "Show"} input file (optional)
          </button>
          {advancedOpen ? (
            <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
              <input
                type="url"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                placeholder="https://example.com/sample.pdf"
                className="rounded border border-border bg-background px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <input
                type="text"
                value={inputFilename}
                onChange={(e) => setInputFilename(e.target.value)}
                placeholder="filename"
                className="w-32 rounded border border-border bg-background px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {inputUrl.length > 0 && !inputUrlLooksValid ? (
                <p className="col-span-2 text-[11px] text-status-failed inline-flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  Input URL must start with http(s)://
                </p>
              ) : (
                <p className="col-span-2 text-[11px] text-muted-foreground">
                  We curl this into <span className="font-mono">/sandbox/inputs/</span>{" "}
                  before the agent runs. Leave blank if the repo provides its own samples.
                </p>
              )}
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="text-[11px] text-status-failed inline-flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            {error}
          </p>
        ) : null}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!canSubmit}
            className={cn(
              "h-9 px-4 rounded text-sm font-medium transition-opacity cursor-pointer inline-flex items-center gap-2",
              canSubmit
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "bg-secondary text-muted-foreground cursor-not-allowed",
            )}
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <PlayCircle className="h-3.5 w-3.5" />
                Run in sandbox
              </>
            )}
          </button>
        </div>
      </form>
    </section>
  );
}

function deriveFilename(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last && last.length > 0 ? last : "input.bin";
  } catch {
    return "input.bin";
  }
}
