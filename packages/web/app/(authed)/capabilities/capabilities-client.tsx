"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { createAvatar } from "@dicebear/core";
import { glass } from "@dicebear/collection";
import { Bot, Clock, ExternalLink, Package, Sparkles, Zap } from "lucide-react";
import { api, type LearnedSkill, type RepoRun } from "@/lib/api/client";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
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
    <div className="relative flex-1 flex flex-col overflow-hidden bg-gradient-to-b from-background to-secondary/20">
      <PageHeader
        title="Capabilities"
        subtitle="Any open-source repo, available to your agents on demand."
      >
        {liveRuns.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-medium text-orange-600 dark:text-orange-400">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-orange-500" />
            </span>
            {liveRuns.length} running
          </span>
        ) : null}
      </PageHeader>

      <div className="px-6 pt-4 flex items-center gap-1.5 text-xs shrink-0">
        {tabs.map((t) => {
          const active = effectiveTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "inline-flex items-center gap-1.5 h-7 px-2.5 rounded transition-colors cursor-pointer",
                active
                  ? "bg-secondary text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/60",
              )}
            >
              <span>{t.label}</span>
              {typeof t.count === "number" && t.count > 0 ? (
                <span className="font-mono tabular-nums text-muted-foreground">
                  {t.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto px-6 pt-5 pb-8">
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

/**
 * DiceBear glass-style avatar for repos. Mirrors the chrome of the
 * agent avatar (same `agent-avatar-glass` frosted badge) but seeded by
 * repo URL and rendered with the colorful `glass` style instead of the
 * `bottts-neutral` robot. Cached per seed so re-renders don't re-encode
 * the data-uri on every paint.
 */
const repoAvatarCache = new Map<string, string>();
function repoAvatarSrc(repoUrl: string) {
  const cached = repoAvatarCache.get(repoUrl);
  if (cached) return cached;
  const src = createAvatar(glass, {
    seed: repoUrl,
    radius: 18,
    scale: 90,
  }).toDataUri();
  repoAvatarCache.set(repoUrl, src);
  return src;
}

function RepoAvatar({ repoUrl, size = 36 }: { repoUrl: string; size?: number }) {
  return (
    <span
      className="agent-avatar-glass inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      <span
        aria-hidden
        className="agent-avatar-glass-avatar"
        style={{ backgroundImage: `url("${repoAvatarSrc(repoUrl)}")` }}
      />
    </span>
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
          className="mt-4 inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"
        >
          Browse curated repos →
        </button>
      </div>
    );
  }
  return (
    <div className="max-w-4xl">
      {skills.map((skill, idx) => (
        <SkillRow key={skill.id} skill={skill} isFirst={idx === 0} />
      ))}
    </div>
  );
}

function SkillRow({ skill, isFirst }: { skill: LearnedSkill; isFirst: boolean }) {
  const name = repoName(skill.repo_url);
  const draft = `Use the "${skill.name}" capability to ${skill.goal_pattern}`;
  return (
    <Link
      href={`/chat?new=1&draft=${encodeURIComponent(draft)}`}
      className={cn(
        "group flex items-center gap-3 px-2 -mx-2 py-3 border-b border-border/40 hover:bg-secondary/20 transition-colors",
        isFirst && "border-t border-border/40",
      )}
    >
      <RepoAvatar repoUrl={skill.repo_url} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-sm truncate">{skill.name}</span>
          <Sparkles className="h-3 w-3 text-muted-foreground/60 shrink-0" />
        </div>
        <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
          {skill.goal_pattern}
        </p>
      </div>
      <span className="hidden sm:inline text-[11px] text-muted-foreground/70 shrink-0">
        via {name}
      </span>
      <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors shrink-0">
        Run again →
      </span>
    </Link>
  );
}

function DiscoverTab() {
  return (
    <div className="space-y-10 max-w-4xl">
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            Curated for common goals
          </h2>
          <p className="text-xs text-muted-foreground">Click a row to try it in chat.</p>
        </div>
        <div>
          {CURATED.map((entry, idx) => (
            <CuratedRow key={entry.repo_url} entry={entry} isFirst={idx === 0} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
          How it works
        </h2>
        <div className="space-y-4">
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
              <div className="mt-0.5 shrink-0">{step.icon}</div>
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

function CuratedRow({ entry, isFirst }: { entry: BoostEntry; isFirst: boolean }) {
  const name = repoName(entry.repo_url);
  const owner = repoOwner(entry.repo_url);
  const draft = `Use ${entry.repo_url} to ${entry.example_goal}`;
  return (
    // The Link covers the whole row via absolute inset-0; the GitHub
    // `source` link sits above it (z-10) as a sibling so it never nests
    // an <a> inside another <a> and clicks route correctly.
    <div
      className={cn(
        "group relative flex items-center gap-3 px-2 -mx-2 py-3 border-b border-border/40 hover:bg-secondary/20 transition-colors",
        isFirst && "border-t border-border/40",
      )}
    >
      <Link
        href={`/chat?new=1&draft=${encodeURIComponent(draft)}`}
        className="absolute inset-0 z-0"
        aria-label={`Try ${name} in chat`}
      />
      <div className="relative pointer-events-none">
        <RepoAvatar repoUrl={entry.repo_url} size={36} />
      </div>
      <div className="relative pointer-events-none min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{name}</span>
          <span className="text-xs text-muted-foreground truncate">{owner}</span>
        </div>
        <p className="text-xs text-muted-foreground/90 italic line-clamp-1 mt-0.5">
          “{entry.example_goal}”
        </p>
      </div>
      <div className="relative pointer-events-none hidden md:flex flex-wrap gap-1 shrink-0 max-w-[200px] justify-end">
        {entry.goal_keywords.slice(0, 3).map((kw) => (
          <span
            key={kw}
            className="inline-flex items-center rounded-sm bg-secondary/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            {kw}
          </span>
        ))}
      </div>
      <a
        href={entry.repo_url}
        target="_blank"
        rel="noopener noreferrer"
        title="Open repo on GitHub"
        className="pointer-events-auto relative z-10 h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors shrink-0"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
      <span className="relative pointer-events-none text-xs text-muted-foreground group-hover:text-foreground transition-colors shrink-0">
        Try →
      </span>
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
    <div className="max-w-3xl">
      {runs.map((run, idx) => (
        <RunCard key={run.id} run={run} isFirst={idx === 0} />
      ))}
    </div>
  );
}
