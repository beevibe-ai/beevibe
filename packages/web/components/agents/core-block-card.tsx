"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { ChatMarkdown } from "@/components/chat/markdown";
import { cn } from "@/lib/utils";
import type { CoreBlockDisplay } from "@/lib/types/core-memory-blocks";

/**
 * Render a single core memory block.
 *
 * Memory blocks aren't all the same shape — `persona` is identity prose,
 * `active_work` is a journal with dated updates, `team_members` is a
 * structured roster. We dispatch on `block_name` so each gets the
 * treatment it deserves; anything we don't recognize falls back to a
 * markdown-rendered prose block. Never a wall of unparsed asterisks.
 */
export function CoreBlockCard({ block }: { block: CoreBlockDisplay }) {
  switch (block.block_name) {
    case "persona":
      return <PersonaBlock block={block} />;
    case "active_work":
      return <ActiveWorkBlock block={block} />;
    case "team_members":
      return <TeamMembersBlock block={block} />;
    default:
      return <ProseBlock block={block} />;
  }
}

// ── Shared chrome ────────────────────────────────────────────────────

function BlockShell({
  accent,
  children,
}: {
  accent?: "primary";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "group relative rounded-lg border border-border bg-card p-4 transition-colors hover:bg-secondary/20",
        accent === "primary" && "border-l-2 border-l-primary",
      )}
    >
      {children}
    </div>
  );
}

function BlockHeader({
  block,
  kindLabel,
}: {
  block: CoreBlockDisplay;
  kindLabel?: string;
}) {
  // The kind label is the human-readable name ("Identity", "Active
  // work"); the raw `block_name` (persona, active_work) sits next to
  // it as a small mono identifier. Char count is dev metadata —
  // hidden until hover, alongside the edit affordance.
  return (
    <div className="flex items-baseline gap-2 mb-2.5">
      {kindLabel ? (
        <span className="text-[10px] uppercase tracking-wider font-semibold text-foreground/85">
          {kindLabel}
        </span>
      ) : null}
      <span className="font-mono text-[10px] text-muted-foreground/80">
        {block.block_name}
      </span>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        <span className="text-[10px] text-muted-foreground/70">
          {block.updated_label}
        </span>
        <span className="text-[10px] text-muted-foreground/50 tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">
          {formatCount(block.char_count)} / {formatCount(block.char_limit)}
        </span>
        <button
          aria-label={`Edit ${block.block_name} block`}
          className="h-5 w-5 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Pencil className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

// ── Persona — identity prose ─────────────────────────────────────────

function PersonaBlock({ block }: { block: CoreBlockDisplay }) {
  // Persona is short by nature (~400 chars), so no collapse — show the
  // whole identity statement at once. Primary left accent stripe makes
  // it read as a quote / mission-statement instead of a config field.
  return (
    <BlockShell accent="primary">
      <BlockHeader block={block} kindLabel="Identity" />
      <div className="text-sm text-foreground/85 italic">
        <ChatMarkdown content={block.content} />
      </div>
    </BlockShell>
  );
}

// ── Active work — journal with dated updates ─────────────────────────

interface ActiveWorkUpdate {
  date: string;
  content: string;
}

function ActiveWorkBlock({ block }: { block: CoreBlockDisplay }) {
  const { current, updates } = parseActiveWork(block.content);
  const [showAll, setShowAll] = useState(false);

  // Newest-first: agents tend to prepend "Update YYYY-MM-DD:" so the
  // most recent context is what we surface; older entries fold below.
  const visible = showAll ? updates : updates.slice(0, 1);

  return (
    <BlockShell>
      <BlockHeader block={block} kindLabel="Active work" />

      {current ? (
        <div className="text-sm text-foreground/90">
          <ChatMarkdown content={current} />
        </div>
      ) : null}

      {updates.length > 0 ? (
        <div className={cn("mt-3 pt-3 border-t border-border/60", !current && "mt-0 pt-0 border-t-0")}>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80 mb-2 font-semibold">
            Updates
          </div>
          <ol className="space-y-3">
            {visible.map((u, i) => (
              <li key={`${u.date}-${i}`} className="relative pl-4">
                {/* Timeline dot — a 6px circle on the left rail anchors
                    each entry to its date. Ties together consecutive
                    journal entries visually. */}
                <span
                  className="absolute left-0 top-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/60"
                  aria-hidden
                />
                <div className="font-mono text-[10px] text-muted-foreground/80 mb-0.5">
                  {u.date}
                </div>
                <div className="text-sm text-foreground/85">
                  <ChatMarkdown content={u.content} />
                </div>
              </li>
            ))}
          </ol>
          {!showAll && updates.length > 1 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              Show {updates.length - 1} earlier update
              {updates.length - 1 === 1 ? "" : "s"}
            </button>
          ) : null}
        </div>
      ) : null}
    </BlockShell>
  );
}

/**
 * Split active_work content into a "current focus" lead + a list of
 * dated updates. Agents write entries like:
 *
 *   "Lead for ~/beevibe ... Update 2026-05-04: M8 still ships Friday.
 *    Update 2026-05-03: Top customer Alice's dashboard..."
 *
 * Returns { current, updates: [{date, content}, ...] } sorted
 * newest-first. If no Update markers are present, current = full
 * content and updates is empty.
 */
function parseActiveWork(content: string): {
  current: string;
  updates: ActiveWorkUpdate[];
} {
  const pattern = /Update\s+(\d{4}-\d{2}-\d{2}):\s*/g;
  const matches: { date: string; start: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    matches.push({ date: m[1], start: m.index, bodyStart: m.index + m[0].length });
  }
  if (matches.length === 0) {
    return { current: content.trim(), updates: [] };
  }
  const current = content.slice(0, matches[0].start).trim();
  const updates = matches.map((match, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].start : content.length;
    return {
      date: match.date,
      content: content.slice(match.bodyStart, end).trim(),
    };
  });
  // Lexicographic sort works for ISO dates; newest first.
  updates.sort((a, b) => b.date.localeCompare(a.date));
  return { current, updates };
}

// ── Team members — structured roster ─────────────────────────────────

interface TeamMember {
  agentId: string;
  role: string;
  description: string;
}

function TeamMembersBlock({ block }: { block: CoreBlockDisplay }) {
  const members = parseTeamMembers(block.content);
  if (members.length === 0) {
    // Parsing fell apart — don't lose the data, render as prose so
    // the user still sees what's there.
    return <ProseBlock block={block} kindLabel="Team members" />;
  }
  return (
    <BlockShell>
      <BlockHeader block={block} kindLabel="Team members" />
      <ul className="space-y-2.5">
        {members.map((m) => (
          <TeamMemberRow key={m.agentId} member={m} />
        ))}
      </ul>
    </BlockShell>
  );
}

function TeamMemberRow({ member }: { member: TeamMember }) {
  const initial = member.role.charAt(0).toUpperCase();
  return (
    <li className="flex items-start gap-2.5">
      <Avatar initial={initial} kind="ic" size={28} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-xs font-semibold text-foreground">
            {member.role}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/80 truncate">
            {member.agentId}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground line-clamp-2">
          {member.description}
        </p>
      </div>
    </li>
  );
}

/**
 * Parse a team_members block into structured rows.
 *
 * Expected entry shape: `- agent_XYZ — **Role name** — description`
 * (em-dash, en-dash, or hyphen separators all OK). Entries are
 * usually newline-separated, but agents sometimes emit them on a
 * single line; the split tolerates both.
 *
 * Returns [] if no entries match — caller should fall back to prose
 * so the original content stays visible.
 */
function parseTeamMembers(content: string): TeamMember[] {
  // Split before each `- agent_` so each chunk holds one entry.
  const chunks = content.split(/(?:^|\s)-\s+(?=agent_)/).map((c) => c.trim()).filter(Boolean);
  const entryPattern = /^agent_(\w+)\s*[—–-]+\s*\*\*([^*]+)\*\*\s*[—–-]+\s*([\s\S]+)$/;
  const members: TeamMember[] = [];
  for (const chunk of chunks) {
    const match = entryPattern.exec(chunk);
    if (!match) continue;
    members.push({
      agentId: `agent_${match[1]}`,
      role: match[2].trim(),
      description: match[3].trim(),
    });
  }
  return members;
}

// ── Prose — markdown-rendered fallback with collapse ────────────────

const COLLAPSE_THRESHOLD = 400;

function ProseBlock({
  block,
  kindLabel,
}: {
  block: CoreBlockDisplay;
  kindLabel?: string;
}) {
  const long = block.content.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!long);
  const visible =
    long && !expanded
      ? block.content.slice(0, COLLAPSE_THRESHOLD).trimEnd() + "…"
      : block.content;
  return (
    <BlockShell>
      <BlockHeader block={block} kindLabel={kindLabel} />
      <div className="text-sm text-foreground/85">
        <ChatMarkdown content={visible} />
      </div>
      {long && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          Show more
        </button>
      ) : null}
    </BlockShell>
  );
}
