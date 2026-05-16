"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Clock, Package, Zap } from "lucide-react";
import { api, type RepoRun } from "@/lib/api/client";
import { RunCard } from "./run-card";

type Tab = "discover" | "activity";

/** Boost-list entry shape (mirrors skills/beevibe-discover-repo/boost-list.json). */
interface BoostEntry {
  repo_url: string;
  goal_keywords: string[];
  language: string;
  category: string;
}

const CURATED: BoostEntry[] = [
  { repo_url: "https://github.com/jsvine/pdfplumber", goal_keywords: ["pdf", "extract", "table"], language: "python", category: "data" },
  { repo_url: "https://github.com/yt-dlp/yt-dlp", goal_keywords: ["youtube", "video", "download", "audio"], language: "python", category: "media" },
  { repo_url: "https://github.com/microsoft/playwright", goal_keywords: ["screenshot", "browser", "scrape", "web"], language: "javascript", category: "web" },
  { repo_url: "https://github.com/FFmpeg/FFmpeg", goal_keywords: ["video", "convert", "audio", "codec"], language: "c", category: "media" },
  { repo_url: "https://github.com/huggingface/transformers", goal_keywords: ["nlp", "summarize", "classify", "translate"], language: "python", category: "ml" },
];

function repoName(url: string) {
  const parts = url.replace("https://github.com/", "").split("/");
  return parts[1] ?? parts[0] ?? url;
}

function repoOwner(url: string) {
  return url.replace("https://github.com/", "").split("/")[0] ?? "";
}

export function CapabilitiesClient() {
  const [tab, setTab] = useState<Tab>("discover");
  const { data, isLoading } = useQuery({
    queryKey: ["repo-runs"],
    queryFn: () => api.repoRuns.list(),
    refetchInterval: 3000,
  });

  const runs = data?.runs ?? [];
  const liveRuns = runs.filter((r) => r.status === "pending" || r.status === "running");

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
        {(["discover", "activity"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "discover" ? "Discover" : "Activity"}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === "discover" && <DiscoverTab />}
        {tab === "activity" && <ActivityTab runs={runs} isLoading={isLoading} />}
      </div>
    </div>
  );
}

function DiscoverTab() {
  return (
    <div className="space-y-8 max-w-4xl">
      {/* Curated picks */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Curated for common goals
        </h2>
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
  return (
    <a
      href={entry.repo_url}
      target="_blank"
      rel="noopener noreferrer"
      className="group block rounded-lg border bg-card hover:bg-muted/50 transition-colors p-4"
    >
      <p className="font-medium text-sm group-hover:text-foreground truncate">{name}</p>
      <p className="text-xs text-muted-foreground truncate">{owner}</p>
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
      <p className="mt-2 text-xs text-muted-foreground">{entry.language} · {entry.category}</p>
    </a>
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
