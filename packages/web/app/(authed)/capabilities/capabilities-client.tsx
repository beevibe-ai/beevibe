"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { createAvatar } from "@dicebear/core";
import { glass } from "@dicebear/collection";
import { Bot, Clock, ExternalLink, Flame, Package, Sparkles, Zap } from "lucide-react";
import { api, type LearnedSkill, type RepoRun } from "@/lib/api/client";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { RunCard } from "./run-card";

type Tab = "yours" | "discover" | "activity";

type TrendingWindow = "daily" | "weekly" | "monthly";

interface TrendingRepo {
  repo_url: string;
  owner: string;
  name: string;
  description: string | null;
  language: string | null;
  /** Stars GAINED in the period — the velocity signal, not lifetime stars. */
  stars_gained: number;
  rank: number;
}
interface TrendingSnapshot {
  fetched_at: string;
  period: TrendingWindow;
  source: string;
  repos: TrendingRepo[];
}

const TRENDING_BASE_URL =
  "https://raw.githubusercontent.com/beevibe-ai/beevibe-capabilities/main/data";

async function fetchTrending(period: TrendingWindow): Promise<TrendingSnapshot> {
  const res = await fetch(`${TRENDING_BASE_URL}/trending-${period}.json`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`trending fetch ${res.status}`);
  return (await res.json()) as TrendingSnapshot;
}

function repoName(url: string) {
  const parts = url.replace("https://github.com/", "").split("/");
  return parts[1] ?? parts[0] ?? url;
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

function RepoAvatar({ repoUrl, size = 28 }: { repoUrl: string; size?: number }) {
  return (
    <span
      className="agent-avatar-glass inline-flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
    >
      <span
        aria-hidden
        className="dicebear-avatar-image"
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
          runs are faster. Start by trying something from Discover.
        </p>
        <button
          onClick={onBrowseCurated}
          className="mt-4 inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"
        >
          Browse trending repos →
        </button>
      </div>
    );
  }
  return (
    <div>
      {skills.map((skill) => (
        <SkillRow key={skill.id} skill={skill} />
      ))}
    </div>
  );
}

function SkillRow({ skill }: { skill: LearnedSkill }) {
  const name = repoName(skill.repo_url);
  const draft = `Use the "${skill.name}" capability to ${skill.goal_pattern}`;
  return (
    <Link
      href={`/chat?new=1&draft=${encodeURIComponent(draft)}`}
      className="group flex items-center gap-2.5 py-2.5 border-b border-border/40 hover:bg-secondary/20 transition-colors"
    >
      <RepoAvatar repoUrl={skill.repo_url} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-sm truncate">{skill.name}</span>
          <Sparkles className="h-3 w-3 text-muted-foreground/60 shrink-0" />
        </div>
        <p className="text-xs text-muted-foreground line-clamp-1">
          {skill.goal_pattern}
        </p>
      </div>
      <span className="hidden sm:inline text-[11px] text-muted-foreground/70 shrink-0 pr-3">
        via {name}
      </span>
      <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors shrink-0">
        Run again →
      </span>
    </Link>
  );
}

function DiscoverTab() {
  const [window, setWindow] = useState<TrendingWindow>("weekly");
  const trendingQuery = useQuery({
    queryKey: ["trending", window],
    queryFn: () => fetchTrending(window),
    staleTime: 60 * 60 * 1000, // 1h — matches the daily refresh cadence
  });

  return (
    <div className="space-y-10">
      <section>
        <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
          <div className="flex items-center gap-1.5">
            <Flame className="h-3.5 w-3.5 text-orange-500" />
            <h2 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
              Trending on GitHub
            </h2>
          </div>
          <div className="flex items-center gap-1 text-[11px]">
            {(["daily", "weekly", "monthly"] as const).map((w) => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={cn(
                  "h-6 px-2 rounded transition-colors cursor-pointer",
                  window === w
                    ? "bg-secondary text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/60",
                )}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Star velocity from OSS Insight — actual growth in the window, not lifetime stars. Click a row to try it in chat.
        </p>
        {trendingQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : trendingQuery.error || !trendingQuery.data ? (
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load trending data. Try again in a moment.
          </p>
        ) : (
          <div>
            {trendingQuery.data.repos.slice(0, 30).map((repo) => (
              <TrendingRow key={repo.repo_url} repo={repo} />
            ))}
          </div>
        )}
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

function TrendingRow({ repo }: { repo: TrendingRepo }) {
  // Seed the chat draft so the user has a starting line they can edit.
  //
  // Trending descriptions are usually noun phrases ("A library to...",
  // ":books: Free programming books", "🤖 Your AI assistant"), not
  // verb phrases. So the previous "Use ${url} to ${description}"
  // template produced grammatically broken sentences like
  // "Use X to A single CLAUDE.md file...". The em-dash separator works
  // regardless: "Try X — <description>" reads cleanly whether the
  // description leads with a verb or a noun.
  //
  // We also strip leading emoji noise from the description so the line
  // doesn't open with ":books:" / "🤖" / "🔥" / etc.
  const cleanedDesc = repo.description
    ?.replace(/^[\s\p{Extended_Pictographic}]+/u, "") // emoji + leading whitespace
    .replace(/^:[a-z_]+:\s*/i, "") // gemoji shortcodes like `:books:`
    .trim();
  const draft = cleanedDesc
    ? `Try ${repo.repo_url} — ${cleanedDesc}`
    : `Try ${repo.repo_url}`;
  const label = `${repo.owner}/${repo.name}`;
  return (
    <div className="group relative flex items-center gap-2.5 py-2.5 border-b border-border/40 hover:bg-secondary/20 transition-colors">
      <Link
        href={`/chat?new=1&draft=${encodeURIComponent(draft)}`}
        className="absolute inset-0 z-0"
        aria-label={`Try ${label} in chat`}
      />
      <div className="relative pointer-events-none">
        <RepoAvatar repoUrl={repo.repo_url} />
      </div>
      <div className="relative pointer-events-none min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{repo.name}</span>
          <span className="text-xs text-muted-foreground truncate">{repo.owner}</span>
        </div>
        <p className="text-xs text-muted-foreground/90 line-clamp-1">
          {repo.description ?? "—"}
        </p>
      </div>
      <div className="relative pointer-events-none hidden md:flex items-center gap-3 shrink-0 pr-2">
        <LanguageBadge language={repo.language} />
        <span
          className="inline-flex items-center gap-0.5 text-[10px] font-medium tabular-nums text-orange-600 dark:text-orange-400"
          title="Stars gained in this window"
        >
          +{formatStars(repo.stars_gained)}★
        </span>
      </div>
      <a
        href={repo.repo_url}
        target="_blank"
        rel="noopener noreferrer"
        title="Open repo on GitHub"
        className="pointer-events-auto relative z-10 h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors shrink-0"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
      <span className="relative pointer-events-none text-xs text-muted-foreground group-hover:text-foreground transition-colors shrink-0 pr-1">
        Try →
      </span>
    </div>
  );
}

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${n}`;
}

/**
 * GitHub Linguist's official language colors (subset of the most common).
 * Used as the colored dot next to the language name — same visual cue
 * GitHub itself uses on repo cards.
 */
const LANGUAGE_COLORS: Record<string, string> = {
  Python: "#3572A5",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Rust: "#dea584",
  Go: "#00ADD8",
  Java: "#b07219",
  C: "#555555",
  "C++": "#f34b7d",
  Swift: "#FA7343",
  Shell: "#89e051",
  HTML: "#e34c26",
  CSS: "#663399",
  Ruby: "#701516",
  PHP: "#4F5D95",
  Kotlin: "#A97BFF",
  Dart: "#00B4AB",
  Haskell: "#5e5086",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  Zig: "#ec915c",
  Lua: "#000080",
  Elixir: "#6e4a7e",
  Clojure: "#db5855",
  MDX: "#fcb32c",
};

function LanguageBadge({ language }: { language: string | null }) {
  if (!language) return null;
  const color = LANGUAGE_COLORS[language] ?? "#8b949e";
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      {language}
    </span>
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
    <div>
      {runs.map((run) => (
        <RunCard key={run.id} run={run} />
      ))}
    </div>
  );
}
