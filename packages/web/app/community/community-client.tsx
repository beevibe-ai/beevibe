"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  GitCompareArrows,
  Layers3,
  Loader2,
  Mail,
  Network,
  RadioTower,
  Search,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { describeError } from "@/lib/api/http";
import { COMMUNITY_ADR_VISUAL_REPORT } from "@/lib/community/adr-visual-report";
import { cn } from "@/lib/utils";

type PatternCategory =
  | "All"
  | "Interface"
  | "Workflow"
  | "Review"
  | "Platform"
  | "Memory";

type Pattern = {
  team: string;
  category: Exclude<PatternCategory, "All">;
  pattern: string;
  signal: string;
  ctoAngle: string;
  scores: {
    clarity: number;
    leverage: number;
    transfer: number;
  };
  tags: string[];
};

const CATEGORIES: PatternCategory[] = [
  "All",
  "Interface",
  "Workflow",
  "Review",
  "Platform",
  "Memory",
];

const PATTERNS: Pattern[] = [
  {
    team: "Linear",
    category: "Workflow",
    pattern: "Opinionated work grammar",
    signal:
      "Issues, cycles, status, ownership, and keyboard flow keep work crisp.",
    ctoAngle:
      "Agent tasks need a tight shape too: owner, review gate, state, and next move.",
    scores: { clarity: 94, leverage: 88, transfer: 92 },
    tags: ["triage", "status", "ownership"],
  },
  {
    team: "Figma",
    category: "Interface",
    pattern: "Multiplayer as the default surface",
    signal:
      "Presence, comments, branches, and live context turn critique into the artifact.",
    ctoAngle:
      "AI teams need shared rooms where agents and humans can inspect the same context.",
    scores: { clarity: 86, leverage: 95, transfer: 89 },
    tags: ["presence", "critique", "artifact"],
  },
  {
    team: "Stripe",
    category: "Memory",
    pattern: "Docs as product infrastructure",
    signal:
      "Canonical examples, constraints, and edge cases reduce support load and drift.",
    ctoAngle:
      "Long-lived agent memory should carry decisions, gotchas, and operating constraints.",
    scores: { clarity: 96, leverage: 91, transfer: 87 },
    tags: ["docs", "constraints", "examples"],
  },
  {
    team: "GitHub",
    category: "Review",
    pattern: "Review embedded in the unit of change",
    signal:
      "Diffs, checks, comments, owners, and merge gates compress review into one loop.",
    ctoAngle:
      "AI deliverables should land with transcript, work product, reviewer action, and audit.",
    scores: { clarity: 90, leverage: 93, transfer: 94 },
    tags: ["review", "checks", "audit"],
  },
  {
    team: "Vercel",
    category: "Platform",
    pattern: "Preview as decision artifact",
    signal:
      "Every change becomes a URL that product, design, and engineering can inspect.",
    ctoAngle:
      "Agent work becomes legible faster when outputs are concrete surfaces, not summaries.",
    scores: { clarity: 91, leverage: 90, transfer: 86 },
    tags: ["preview", "handoff", "artifact"],
  },
  {
    team: "OpenAI",
    category: "Review",
    pattern: "Evals before shipping judgment",
    signal:
      "Behavioral tests make qualitative progress visible before a release depends on it.",
    ctoAngle:
      "AI CTO workflows need repeatable checks for agents, prompts, memory, and tools.",
    scores: { clarity: 83, leverage: 96, transfer: 90 },
    tags: ["evals", "quality", "release"],
  },
];

const ISSUES = [
  {
    title: "Preview environments as leadership surface",
    note: "How teams turn an implementation detail into faster product judgment.",
    focus: "Vercel, GitHub, Beevibe tasks",
  },
  {
    title: "Shared memory without knowledge sludge",
    note: "The difference between useful context and permanent organizational noise.",
    focus: "Stripe docs, Figma comments, agent memory",
  },
  {
    title: "Review loops for AI-made work",
    note: "Patterns that keep speed high while preserving ownership and taste.",
    focus: "GitHub reviews, Linear states, eval gates",
  },
];

const RADAR = [
  { label: "Context permanence", value: 92 },
  { label: "Handoff clarity", value: 88 },
  { label: "Review loop", value: 94 },
  { label: "Artifact quality", value: 86 },
  { label: "Signal density", value: 91 },
];

export function CommunityClient() {
  const [activeCategory, setActiveCategory] = useState<PatternCategory>("All");

  const visiblePatterns = useMemo(
    () =>
      activeCategory === "All"
        ? PATTERNS
        : PATTERNS.filter((pattern) => pattern.category === activeCategory),
    [activeCategory],
  );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <TopBar />
      <section className="px-5 sm:px-6 lg:px-8 pt-12 pb-10 border-b border-border/60">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-[minmax(0,0.9fr)_minmax(520px,1.1fr)] gap-8 lg:gap-12 items-center">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <RadioTower className="h-3.5 w-3.5 text-status-running" />
              Beevibe Community
            </div>
            <h1 className="mt-4 text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-normal leading-[1.02] max-w-3xl">
              Building Patterns Index
            </h1>
            <p className="mt-5 max-w-2xl text-base sm:text-lg leading-8 text-muted-foreground">
              A curated map of how excellent teams turn taste into operating
              systems: product rituals, design surfaces, review gates, memory
              loops, and platform primitives worth stealing for AI-native work.
            </p>
            <div className="mt-7 flex flex-col sm:flex-row gap-3">
              <a
                href="#patterns"
                className="inline-flex h-10 items-center justify-center gap-2 rounded bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
              >
                <GitCompareArrows className="h-4 w-4" />
                Browse patterns
              </a>
              <a
                href="#newsletter"
                className="inline-flex h-10 items-center justify-center gap-2 rounded border border-border bg-card/70 px-4 text-sm font-semibold hover:bg-secondary/70 transition-colors"
              >
                <Mail className="h-4 w-4" />
                Get the brief
              </a>
            </div>
          </div>

          <PatternAtlas patterns={PATTERNS} />
        </div>
      </section>

      <section id="patterns" className="px-5 sm:px-6 lg:px-8 py-10">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Search className="h-3.5 w-3.5 text-status-done" />
                Pattern library
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-normal">
                Compare what is actually being built
              </h2>
            </div>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => setActiveCategory(category)}
                  className={cn(
                    "h-8 rounded-full px-3 text-xs font-semibold transition-colors",
                    activeCategory === category
                      ? "bg-foreground text-background"
                      : "border border-border bg-card/70 text-muted-foreground hover:text-foreground hover:bg-secondary",
                  )}
                >
                  {category}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6 grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {visiblePatterns.map((pattern) => (
              <PatternCard key={`${pattern.team}-${pattern.pattern}`} pattern={pattern} />
            ))}
          </div>
        </div>
      </section>

      <ReportVisuals />

      <section className="px-5 sm:px-6 lg:px-8 py-10 border-y border-border/60 bg-secondary/25">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-[0.85fr_1.15fr] gap-8">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Network className="h-3.5 w-3.5 text-status-review" />
              Community loop
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-normal">
              From curation to compounding context
            </h2>
            <p className="mt-3 text-sm leading-7 text-muted-foreground max-w-xl">
              The community layer should not be another feed. It should become a
              shared pattern memory: what changed, why it mattered, what failed
              to transfer, and how Beevibe agents can apply the lesson inside
              real work.
            </p>
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            {[
              {
                icon: BookOpenText,
                label: "Curate",
                text: "Collect primary artifacts, teardown notes, and durable product moves.",
              },
              {
                icon: GitCompareArrows,
                label: "Compare",
                text: "Score patterns by clarity, leverage, transferability, and risk.",
              },
              {
                icon: Layers3,
                label: "Operationalize",
                text: "Convert strong patterns into agent memory, tasks, and review playbooks.",
              },
            ].map((item) => (
              <div key={item.label} className="rounded-lg glass-surface p-4">
                <item.icon className="h-5 w-5 text-foreground/80" />
                <div className="mt-3 text-sm font-semibold">{item.label}</div>
                <p className="mt-2 text-xs leading-6 text-muted-foreground">
                  {item.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="newsletter" className="px-5 sm:px-6 lg:px-8 py-12">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-[0.9fr_1.1fr] gap-8 items-start">
          <NewsletterPanel />
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Upcoming briefs
            </div>
            {ISSUES.map((issue) => (
              <article key={issue.title} className="rounded-lg border border-border bg-card/70 p-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 h-7 w-7 rounded bg-primary/20 text-primary-foreground border border-primary/30 flex items-center justify-center shrink-0">
                    <ArrowRight className="h-3.5 w-3.5 text-foreground" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold">{issue.title}</h3>
                    <p className="mt-1 text-xs leading-6 text-muted-foreground">
                      {issue.note}
                    </p>
                    <p className="mt-2 text-[11px] uppercase tracking-wider text-muted-foreground/70">
                      {issue.focus}
                    </p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

function ReportVisuals() {
  const report = COMMUNITY_ADR_VISUAL_REPORT;
  const maxEvidenceCount = Math.max(
    1,
    ...report.evidenceMix.map((entry) => entry.count),
  );

  return (
    <section className="px-5 sm:px-6 lg:px-8 pb-10">
      <div className="max-w-7xl mx-auto rounded-lg border border-border bg-card/65 overflow-hidden">
        <div className="grid lg:grid-cols-[0.9fr_1.1fr]">
          <div className="p-5 sm:p-6 border-b lg:border-b-0 lg:border-r border-border">
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <GitCompareArrows className="h-3.5 w-3.5 text-status-running" />
              ADR visual report
            </div>
            <h2 className="mt-3 text-2xl font-semibold tracking-normal">
              {report.decision.title}
            </h2>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              {report.decision.summary}
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              {report.kpis.map((kpi) => (
                <div
                  key={kpi.id}
                  className="rounded border border-border bg-background/60 p-3"
                >
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {kpi.label}
                  </div>
                  <div
                    className={cn(
                      "mt-1 text-lg font-semibold tabular-nums",
                      kpi.tone === "good"
                        ? "text-status-done"
                        : kpi.tone === "warning"
                          ? "text-status-review"
                          : kpi.tone === "critical"
                            ? "text-status-failed"
                            : "text-foreground",
                    )}
                  >
                    {kpi.value}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-5 rounded border border-border bg-background/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold">Matrix coverage</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {report.matrixCoverage.filledCells} of{" "}
                    {report.matrixCoverage.totalCells} scored cells
                  </div>
                </div>
                <div className="text-xl font-semibold tabular-nums">
                  {report.matrixCoverage.coveragePercent}%
                </div>
              </div>
              <div className="mt-3 grid grid-cols-10 gap-1">
                {Array.from({ length: report.matrixCoverage.totalCells }).map((_, i) => (
                  <div
                    key={i}
                    className={cn(
                      "aspect-square rounded-sm",
                      i < report.matrixCoverage.filledCells
                        ? "bg-status-done"
                        : "bg-secondary",
                    )}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="p-5 sm:p-6 space-y-5">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Decision funnel
              </div>
              <div className="mt-3 grid grid-cols-5 gap-2">
                {report.decisionFunnel.map((step, index) => (
                  <div key={step.label} className="min-w-0">
                    <div
                      className={cn(
                        "h-2 rounded-full",
                        index === report.decisionFunnel.length - 1
                          ? "bg-primary"
                          : "bg-foreground/80",
                      )}
                    />
                    <div className="mt-2 text-sm font-semibold tabular-nums">
                      {step.count}
                    </div>
                    <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground truncate">
                      {step.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Evidence mix
              </div>
              <div className="mt-3 space-y-2">
                {report.evidenceMix.map((entry) => (
                  <div
                    key={entry.sourceType}
                    className="grid grid-cols-[132px_1fr_34px] items-center gap-3"
                  >
                    <div className="text-xs text-muted-foreground truncate">
                      {entry.sourceType.replace(/_/g, " ")}
                    </div>
                    <div className="h-2 rounded-full bg-secondary overflow-hidden">
                      <div
                        className="h-full rounded-full bg-status-running"
                        style={{
                          width: `${Math.max(8, (entry.count / maxEvidenceCount) * 100)}%`,
                        }}
                      />
                    </div>
                    <div className="text-right text-xs tabular-nums">
                      {entry.count}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Risk signals
              </div>
              <div className="mt-3 grid md:grid-cols-3 gap-2">
                {report.riskSignals.map((signal) => (
                  <div key={signal.topic} className="rounded border border-border bg-background/60 p-3">
                    <div className="text-xs font-semibold">{signal.topic}</div>
                    <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                      {signal.risk}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function TopBar() {
  return (
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto h-14 px-5 sm:px-6 lg:px-8 flex items-center gap-4">
        <Link href="/" className="flex items-center gap-2 min-w-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="Beevibe"
            className="h-7 w-7 rounded-md object-cover object-center shrink-0"
          />
          <span className="text-sm font-semibold tracking-normal">Beevibe</span>
        </Link>
        <nav className="ml-auto flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <a href="#patterns" className="hidden sm:inline-flex h-8 items-center px-2 hover:text-foreground">
            Patterns
          </a>
          <a href="#newsletter" className="hidden sm:inline-flex h-8 items-center px-2 hover:text-foreground">
            Newsletter
          </a>
          <Link
            href="/sign-up"
            className="inline-flex h-8 items-center justify-center rounded bg-foreground px-3 text-background hover:opacity-90 transition-opacity"
          >
            Join
          </Link>
        </nav>
      </div>
    </header>
  );
}

function PatternAtlas({ patterns }: { patterns: Pattern[] }) {
  const topPatterns = patterns.slice(0, 5);

  return (
    <div className="rounded-lg glass-surface p-4 sm:p-5">
      <div className="grid sm:grid-cols-[1fr_180px] gap-5">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Signal map
              </div>
              <div className="mt-1 text-sm font-semibold">
                Patterns by transfer value
              </div>
            </div>
            <div className="text-[11px] tabular-nums text-muted-foreground">
              {patterns.length} references
            </div>
          </div>

          <div className="space-y-2">
            {topPatterns.map((pattern, index) => {
              const value = Math.round(
                (pattern.scores.clarity +
                  pattern.scores.leverage +
                  pattern.scores.transfer) /
                  3,
              );
              return (
                <div key={pattern.team} className="grid grid-cols-[84px_1fr_34px] items-center gap-3">
                  <div className="text-xs font-medium truncate">{pattern.team}</div>
                  <div className="h-2 rounded-full bg-secondary overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        index % 3 === 0
                          ? "bg-status-running"
                          : index % 3 === 1
                            ? "bg-status-done"
                            : "bg-primary",
                      )}
                      style={{ width: `${value}%` }}
                    />
                  </div>
                  <div className="text-right text-xs tabular-nums text-muted-foreground">
                    {value}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-background/55 p-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            AI CTO fit
          </div>
          <div className="mt-3 space-y-2.5">
            {RADAR.map((item) => (
              <div key={item.label}>
                <div className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="text-muted-foreground">{item.label}</span>
                  <span className="tabular-nums">{item.value}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                  <div
                    className="h-full rounded-full bg-foreground"
                    style={{ width: `${item.value}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PatternCard({ pattern }: { pattern: Pattern }) {
  const avg = Math.round(
    (pattern.scores.clarity + pattern.scores.leverage + pattern.scores.transfer) /
      3,
  );

  return (
    <article className="rounded-lg border border-border bg-card/75 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-muted-foreground">
            {pattern.team}
          </div>
          <h3 className="mt-1 text-base font-semibold tracking-normal">
            {pattern.pattern}
          </h3>
        </div>
        <div className="h-9 w-9 rounded bg-secondary flex items-center justify-center text-sm font-semibold tabular-nums shrink-0">
          {avg}
        </div>
      </div>
      <p className="mt-3 text-sm leading-7 text-foreground/85">{pattern.signal}</p>
      <p className="mt-3 text-xs leading-6 text-muted-foreground">
        {pattern.ctoAngle}
      </p>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {[
          ["Clarity", pattern.scores.clarity],
          ["Leverage", pattern.scores.leverage],
          ["Transfer", pattern.scores.transfer],
        ].map(([label, value]) => (
          <div key={label} className="rounded border border-border bg-background/55 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {label}
            </div>
            <div className="mt-1 text-sm font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {pattern.tags.map((tag) => (
          <span
            key={tag}
            className="rounded-full bg-secondary px-2 py-1 text-[11px] text-muted-foreground"
          >
            {tag}
          </span>
        ))}
      </div>
    </article>
  );
}

function NewsletterPanel() {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success">("idle");
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isApiConfigured) {
      setError("Newsletter capture is not configured for this deployment.");
      return;
    }
    setStatus("submitting");
    setError(null);
    try {
      await api.newsletter.subscribe({
        email: email.trim(),
        source: "community",
        website,
      });
      setStatus("success");
    } catch (err) {
      setStatus("idle");
      setError(describeError(err));
    }
  };

  return (
    <div className="rounded-lg glass-surface p-5 sm:p-6">
      <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Mail className="h-3.5 w-3.5 text-status-running" />
        Weekly newsletter
      </div>
      <h2 className="mt-3 text-2xl font-semibold tracking-normal">
        The brief for builders who care about the work beneath the launch.
      </h2>
      <p className="mt-3 text-sm leading-7 text-muted-foreground">
        One issue each week: a teardown, a comparison matrix, implementation
        notes, and the Beevibe angle for AI-native teams.
      </p>

      <form onSubmit={submit} className="mt-5 space-y-3">
        <label htmlFor="community-email" className="sr-only">
          Email
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            id="community-email"
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            disabled={status === "submitting" || status === "success"}
            className="min-w-0 flex-1 h-10 rounded border border-border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={status === "submitting" || status === "success"}
            className="inline-flex h-10 items-center justify-center gap-2 rounded bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
          >
            {status === "submitting" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Joining
              </>
            ) : status === "success" ? (
              <>
                <CheckCircle2 className="h-4 w-4" />
                Joined
              </>
            ) : (
              <>
                <Mail className="h-4 w-4" />
                Subscribe
              </>
            )}
          </button>
        </div>
        <label className="sr-only" htmlFor="community-website">
          Website
        </label>
        <input
          id="community-website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
          className="sr-only"
          aria-hidden="true"
        />
        {error ? (
          <p className="text-xs text-status-failed">{error}</p>
        ) : status === "success" ? (
          <p className="text-xs text-status-done">
            You are on the list. First issue will focus on preview environments.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            No generic launch recap. Just patterns, artifacts, and judgment.
          </p>
        )}
      </form>
    </div>
  );
}
