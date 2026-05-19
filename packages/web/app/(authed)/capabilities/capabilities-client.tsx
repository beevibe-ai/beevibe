"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Bot, Clock, Package, Sparkles, Zap } from "lucide-react";
import { api, type LearnedSkill, type RepoRun } from "@/lib/api/client";
import { RunCard } from "./run-card";

type Tab = "yours" | "discover" | "activity";

/** Boost-list entry shape (mirrors skills/beevibe-discover-repo/boost-list.json). */
interface BoostEntry {
  repo_url: string;
  goal_keywords: string[];
  language: string;
  category: string;
  /** Example goal the agent can run — seeds the chat draft when the card is clicked. */
  example_goal: string;
}

const CURATED: BoostEntry[] = [
  { repo_url: "https://github.com/jsvine/pdfplumber", goal_keywords: ["pdf", "extract", "table"], language: "python", category: "data", example_goal: "extract tables from a PDF" },
  { repo_url: "https://github.com/yt-dlp/yt-dlp", goal_keywords: ["youtube", "video", "download", "audio"], language: "python", category: "media", example_goal: "download the audio from a YouTube video" },
  { repo_url: "https://github.com/microsoft/playwright", goal_keywords: ["screenshot", "browser", "scrape", "web"], language: "javascript", category: "web", example_goal: "take a screenshot of a website" },
  { repo_url: "https://github.com/FFmpeg/FFmpeg", goal_keywords: ["video", "convert", "audio", "codec"], language: "c", category: "media", example_goal: "convert a video to a different format" },
  { repo_url: "https://github.com/huggingface/transformers", goal_keywords: ["nlp", "summarize", "classify", "translate"], language: "python", category: "ml", example_goal: "summarize a long article" },
];

function repoName(url: string) {
  const parts = url.replace("https://github.com/", "").split("/");
  return parts[1] ?? parts[0] ?? url;
}

function repoOwner(url: string) {
  return url.replace("https://github.com/", "").split("/")[0] ?? "";
}

export function CapabilitiesClient() {
  const runsQuery = useQuery({
    queryKey: ["repo-runs"],
    queryFn: () => api.repoRuns.list(),
    refetchInterval: 3000,
  });
  const skillsQuery = useQuery({
    queryKey: ["learned-skills"],
    queryFn: () => api.learnedSkills.list(),
  });

  const runs = runsQuery.data?.runs ?? [];
  const skills = skillsQuery.data?.skills ?? [];
  const liveRuns = runs.filter((r) => r.status === "pending" || r.status === "running");

  // Default tab: "yours" once the user has saved at least one capability,
  // otherwise "discover" so new users have something to click.
  const [tab, setTab] = useState<Tab>("discover");
  const effectiveTab: Tab =
    tab === "discover" && skills.length > 0 && !skillsQuery.isLoading ? "yours" : tab;

  const tabs: Array<{ key: Tab; label: string; count?: number }> = [
    { key: "yours", label: "Your capabilities", count: skills.length },
    { key: "discover", label: "Discover" },
    { key: "activity", label: "Activity", count: runs.length },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="border-b px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-xl font-semibold">Capabilities</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Any open-source repo, available to your agents on demand.
          </p>
        </div>
        {liveRuns.length > 0 && (
          <span className="flex items-center gap-1.5 text-sm text-orange-600 dark:text-orange-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500" />
            </span>
            {liveRuns.length} running
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b px-6 flex gap-6 flex-shrink-0">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`py-3 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
              effectiveTab === t.key
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            {typeof t.count === "number" && t.count > 0 && (
              <span className="text-xs text-muted-foreground/70 font-normal">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {effectiveTab === "yours" && (
          <YoursTab
            skills={skills}
            isLoading={skillsQuery.isLoading}
            onBrowseCurated={() => setTab("discover")}
          />
        )}
        {effectiveTab === "discover" && <DiscoverTab />}
        {effectiveTab === "activity" && (
          <ActivityTab runs={runs} isLoading={runsQuery.isLoading} />
        )}
      </div>
    </div>
  );
}

function YoursTab({
  skills,
  isLoading,
  onBrowseCurated,
}: {
  skills: LearnedSkill[];
  isLoading: boolean;
  onBrowseCurated: () => void;
}) {
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center max-w-md mx-auto">
        <Sparkles className="h-8 w-8 text-muted-foreground/40 mb-3" />
        <p className="text-sm font-medium">No capabilities saved yet</p>
        <p className="text-sm text-muted-foreground mt-1">
          When an agent uses a repo to finish a task, you can save the recipe so future
          runs are faster. Start by trying one of the curated repos in Discover.
        </p>
        <button
          onClick={onBrowseCurated}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
        >
          Browse curated repos →
        </button>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-w-4xl">
      {skills.map((skill) => (
        <SkillCard key={skill.id} skill={skill} />
      ))}
    </div>
  );
}

function SkillCard({ skill }: { skill: LearnedSkill }) {
  const name = repoName(skill.repo_url);
  const draft = `Use the "${skill.name}" capability to ${skill.goal_pattern}`;
  return (
    <Link
      href={`/chat?new=1&draft=${encodeURIComponent(draft)}`}
      className="group block rounded-lg border bg-card hover:bg-muted/50 transition-colors p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-sm truncate">{skill.name}</p>
        <Sparkles className="h-3.5 w-3.5 text-muted-foreground/60 flex-shrink-0 mt-0.5" />
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2 mt-1">{skill.goal_pattern}</p>
      <p className="text-[11px] text-muted-foreground/70 mt-2 truncate">via {name}</p>
      <p className="mt-3 text-xs text-foreground/80 group-hover:text-foreground">
        Run it again →
      </p>
    </Link>
  );
}

function DiscoverTab() {
  return (
    <div className="space-y-8 max-w-4xl">
      {/* Curated picks */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Curated for common goals
          </h2>
          <p className="text-xs text-muted-foreground">Click a card to try it in chat.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {CURATED.map((entry) => (
            <CuratedCard key={entry.repo_url} entry={entry} />
          ))}
        </div>
      </section>

      {/* How it works */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          How it works
        </h2>
        <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
          {[
            {
              icon: <Zap className="h-4 w-4 text-yellow-500" />,
              title: "Tell your agent what you need",
              desc: 'Say "extract tables from this PDF" or "download the audio from this video." The agent finds the right open-source repo.',
            },
            {
              icon: <Package className="h-4 w-4 text-blue-500" />,
              title: "Runs in a fresh Docker sandbox",
              desc: "The repo is cloned, deps installed, and the goal executed — entirely inside an isolated container. Your host machine is never touched.",
            },
            {
              icon: <Bot className="h-4 w-4 text-green-500" />,
              title: "Artifact lands for review",
              desc: "The result shows up in your inbox as a work product. Approve it to save the recipe as a reusable capability.",
            },
          ].map((step) => (
            <div key={step.title} className="flex gap-3 items-start">
              <div className="mt-0.5 flex-shrink-0">{step.icon}</div>
              <div>
                <p className="text-sm font-medium">{step.title}</p>
                <p className="text-sm text-muted-foreground">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function CuratedCard({ entry }: { entry: BoostEntry }) {
  const name = repoName(entry.repo_url);
  const owner = repoOwner(entry.repo_url);
  const draft = `Use ${entry.repo_url} to ${entry.example_goal}`;
  return (
    // The Link covers the whole card via absolute inset-0; the GitHub
    // `source ↗` link sits above it (z-10) as a sibling so it never
    // nests an <a> inside another <a> and clicks route correctly.
    <div className="group relative rounded-lg border bg-card hover:bg-muted/50 transition-colors">
      <Link
        href={`/chat?new=1&draft=${encodeURIComponent(draft)}`}
        className="absolute inset-0 z-0"
        aria-label={`Try ${name} in chat`}
      />
      <div className="relative p-4 pb-3 pointer-events-none">
        <p className="font-medium text-sm group-hover:text-foreground truncate">{name}</p>
        <p className="text-xs text-muted-foreground truncate">{owner}</p>
        <p className="text-xs text-muted-foreground/80 mt-2 line-clamp-2 italic">
          “{entry.example_goal}”
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {entry.goal_keywords.slice(0, 3).map((kw) => (
            <span
              key={kw}
              className="inline-flex items-center rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              {kw}
            </span>
          ))}
        </div>
      </div>
      <div className="relative border-t px-4 py-2 flex items-center justify-between pointer-events-none">
        <span className="text-xs text-foreground/80 group-hover:text-foreground">
          Try in chat →
        </span>
        <a
          href={entry.repo_url}
          target="_blank"
          rel="noopener noreferrer"
          className="pointer-events-auto relative z-10 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          source ↗
        </a>
      </div>
    </div>
  );
}

function ActivityTab({ runs, isLoading }: { runs: RepoRun[]; isLoading: boolean }) {
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading runs…</p>;
  }
  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Clock className="h-8 w-8 text-muted-foreground/40 mb-3" />
        <p className="text-sm font-medium">No runs yet</p>
        <p className="text-sm text-muted-foreground mt-1">
          Ask an agent to use a repo — runs will appear here in real time.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3 max-w-3xl">
      {runs.map((run) => (
        <RunCard key={run.id} run={run} />
      ))}
    </div>
  );
}
