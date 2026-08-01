"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Info, Scale } from "lucide-react";
import { MeshBackLink } from "@/components/detail/mesh-back-link";
import { useEscalation } from "@/lib/hooks/use-escalations";
import { useResolveEscalation } from "@/lib/hooks/use-escalation-mutations";
import { ChatMarkdown } from "@/components/chat/markdown";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { DetailGate } from "@/components/detail/detail-gate";
import { FooterField } from "@/components/detail/footer-field";
import { Skeleton } from "@/components/skeleton";
import { EscalationStatusPill } from "@/components/detail/status-pill";
import { MutationError } from "@/components/mutation-error";
import { formatRelativeTime } from "@/lib/format";
import type { EscalationResolveInput } from "@/lib/api/client";
import type {
  EscalationProposal,
  EscalationRecoveredPosition,
  EscalationReviewDetail,
} from "@/lib/types/escalations";

type Side = "initiator" | "counterparty";

interface SideView {
  label: string;
  agentName: string;
  escalated: boolean;
  proposals?: EscalationProposal[];
  openQuestions: string[];
  submittedAt?: string;
  recovered?: EscalationRecoveredPosition;
}

export function EscalationDetailClient({ escalationId }: { escalationId: string }) {
  const query = useEscalation(escalationId);

  return (
    <DetailGate
      nav={<MeshBackLink />}
      icon={Scale}
      noun="escalation"
      id={escalationId}
      query={query}
      skeleton={
        <>
          <Skeleton className="h-7 w-40 mb-4" />
          <Skeleton className="h-24 w-full rounded-lg mb-6" />
          <div className="grid grid-cols-2 gap-4">
            <Skeleton className="h-48 w-full rounded-lg" />
            <Skeleton className="h-48 w-full rounded-lg" />
          </div>
        </>
      }
    >
      {(data) => <EscalationDetailLoaded esc={data.escalation} />}
    </DetailGate>
  );
}

function EscalationDetailLoaded({ esc }: { esc: EscalationReviewDetail }) {
  const initiator: SideView = {
    label: "Initiator",
    agentName: esc.initiator_agent_name,
    escalated: esc.escalated_by_role === "initiator",
    proposals: esc.initiator_proposals,
    openQuestions: esc.initiator_open_questions,
    submittedAt: esc.initiator_submitted_at,
    recovered: esc.initiator_recovered,
  };
  const counterparty: SideView = {
    label: "Counterparty",
    agentName: esc.counterparty_agent_name,
    escalated: esc.escalated_by_role === "counterparty",
    proposals: esc.counterparty_proposals,
    openQuestions: esc.counterparty_open_questions,
    submittedAt: esc.counterparty_submitted_at,
    recovered: esc.counterparty_recovered,
  };

  return (
    <>
      <header className="mb-6">
        <div className="flex items-start justify-between gap-6 mb-3">
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight leading-tight">Escalation</h1>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {esc.initiator_agent_name}
              <span className="text-muted-foreground/50 mx-1.5">↔</span>
              {esc.counterparty_agent_name}
            </p>
          </div>
          <EscalationStatusPill status={esc.status} />
        </div>
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
            Summary
          </h2>
          <div className="text-foreground/90">
            <ChatMarkdown content={esc.summary} />
          </div>
        </section>
      </header>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <SideCard side={initiator} />
        <SideCard side={counterparty} />
      </div>

      {esc.status === "pending" ? <ResolveForm esc={esc} /> : <ResolvedView esc={esc} />}

      <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
        <FooterField label="ID">
          <ClickToCopyId id={esc.id} />
        </FooterField>
        <FooterField label="Negotiation">
          <Link href="/mesh" className="font-mono hover:text-foreground transition-colors">
            {esc.negotiation_id}
          </Link>
        </FooterField>
        <FooterField label="Escalated by">{esc.escalated_by_role}</FooterField>
        <FooterField label="Created">{formatRelativeTime(esc.created_at)}</FooterField>
        {esc.resolved_at ? (
          <FooterField label="Resolved">{formatRelativeTime(esc.resolved_at)}</FooterField>
        ) : null}
      </footer>
    </>
  );
}

function SideCard({ side }: { side: SideView }) {
  const { label, agentName, escalated, proposals, openQuestions, submittedAt, recovered } = side;
  const hasProposals = (proposals?.length ?? 0) > 0;
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
          {label}
        </h3>
        {escalated ? (
          <span className="text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400">
            escalated
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground/70 shrink-0">
          {submittedAt ? formatRelativeTime(submittedAt) : "never filed"}
        </span>
      </div>
      <div className="text-sm font-medium text-foreground mb-3 truncate">{agentName}</div>

      {recovered ? (
        <div className="mb-3 rounded-md border border-dashed border-border bg-muted/30 p-3">
          <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-muted-foreground">
            <Info className="h-3 w-3 shrink-0" />
            Recovered from round {recovered.from_round} ({recovered.decision}) — this side never
            filed.
          </div>
          <div className="text-sm text-foreground/90">
            <ChatMarkdown content={recovered.message} />
          </div>
        </div>
      ) : null}

      {hasProposals ? (
        <ul className="space-y-3">
          {(proposals ?? []).map((p, i) => (
            <li key={`${i}:${p.title}`} className="rounded-md border border-border/60 p-3">
              <div className="text-sm font-medium mb-1">
                <span className="text-muted-foreground tabular-nums mr-1.5">{i + 1}.</span>
                {p.title}
              </div>
              <div className="text-xs text-foreground/80">
                <ChatMarkdown content={p.description} />
              </div>
              {p.tradeoffs ? (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  <span className="font-medium">Trade-offs:</span> {p.tradeoffs}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : !recovered ? (
        <p className="text-sm text-muted-foreground italic">No proposals filed.</p>
      ) : null}

      {openQuestions.length > 0 ? (
        <div className="mt-3">
          <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground/80 mb-1.5 font-medium">
            Open questions
          </h4>
          <ul className="space-y-1">
            {openQuestions.map((q) => (
              <li key={q} className="text-xs text-foreground/80 flex gap-1.5">
                <span className="text-muted-foreground/60">·</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function ResolveForm({ esc }: { esc: EscalationReviewDetail }) {
  const resolve = useResolveEscalation(esc.id);

  const pickable: Array<{ side: Side; index: number; proposal: EscalationProposal }> = [
    ...(esc.initiator_proposals ?? []).map((proposal, index) => ({
      side: "initiator" as Side,
      index,
      proposal,
    })),
    ...(esc.counterparty_proposals ?? []).map((proposal, index) => ({
      side: "counterparty" as Side,
      index,
      proposal,
    })),
  ];

  const [mode, setMode] = useState<"pick" | "human">(pickable.length > 0 ? "pick" : "human");
  const [picked, setPicked] = useState(0);
  // `undefined` = use the picked proposal's value; any string (incl. "") =
  // the user overrode it. Avoids the title/description-shadow-the-proposal
  // sync dance and makes "edited" a single boolean derived from these.
  const [editedTitle, setEditedTitle] = useState<string | undefined>(undefined);
  const [editedDescription, setEditedDescription] = useState<string | undefined>(undefined);
  const [notes, setNotes] = useState("");

  const selected = pickable[picked];
  const sourceTitle = mode === "pick" ? selected?.proposal.title ?? "" : "";
  const sourceDescription = mode === "pick" ? selected?.proposal.description ?? "" : "";
  const displayTitle = editedTitle ?? sourceTitle;
  const displayDescription = editedDescription ?? sourceDescription;
  const isEdited =
    mode === "pick" && (editedTitle !== undefined || editedDescription !== undefined);
  const canSubmit =
    displayTitle.trim().length > 0 &&
    displayDescription.trim().length > 0 &&
    !resolve.isPending;

  const selectProposal = (i: number) => {
    setPicked(i);
    setEditedTitle(undefined);
    setEditedDescription(undefined);
  };
  const switchMode = (m: "pick" | "human") => {
    setMode(m);
    setEditedTitle(undefined);
    setEditedDescription(undefined);
  };

  const submit = () => {
    if (!canSubmit) return;
    let input: EscalationResolveInput;
    if (mode === "human") {
      input = {
        source: "human",
        title: displayTitle.trim(),
        description: displayDescription.trim(),
        resolution_notes: notes.trim() || undefined,
      };
    } else {
      if (!selected) return;
      input = {
        source: selected.side,
        source_index: selected.index,
        edited_title: editedTitle !== undefined ? editedTitle.trim() : undefined,
        edited_description:
          editedDescription !== undefined ? editedDescription.trim() : undefined,
        resolution_notes: notes.trim() || undefined,
      };
    }
    resolve.mutate(input);
  };

  const inputClass =
    "w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring";
  const labelClass =
    "block text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-1";

  return (
    <section className="rounded-lg border border-border bg-card p-5 mb-6">
      <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-4 font-medium">
        Resolution
      </h2>

      <div className="flex gap-2 mb-4">
        <ModeButton
          active={mode === "pick"}
          disabled={pickable.length === 0}
          onClick={() => switchMode("pick")}
        >
          Pick a proposal
        </ModeButton>
        <ModeButton active={mode === "human"} onClick={() => switchMode("human")}>
          Write my own
        </ModeButton>
      </div>

      {mode === "pick" ? (
        <div className="space-y-1.5 mb-4">
          {pickable.map((item, i) => (
            <label
              key={`${item.side}:${item.index}`}
              className={`flex items-start gap-2 rounded-md border p-2.5 cursor-pointer transition-colors ${
                picked === i ? "border-primary bg-primary/5" : "border-border/60 hover:bg-secondary/30"
              }`}
            >
              <input
                type="radio"
                name="proposal"
                checked={picked === i}
                onChange={() => selectProposal(i)}
                className="mt-0.5"
              />
              <div className="min-w-0">
                <div className="text-[11px]">
                  <span className="uppercase tracking-wider text-muted-foreground">{item.side}</span>
                  <span className="text-muted-foreground/70 tabular-nums"> · #{item.index + 1}</span>
                </div>
                <div className="text-sm font-medium">{item.proposal.title}</div>
              </div>
            </label>
          ))}
        </div>
      ) : null}

      <div className="space-y-3">
        <div>
          <label className={labelClass}>Title</label>
          <input
            value={displayTitle}
            onChange={(e) => setEditedTitle(e.target.value)}
            placeholder="Decision title"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Description</label>
          <textarea
            value={displayDescription}
            onChange={(e) => setEditedDescription(e.target.value)}
            placeholder="What both sides should do"
            rows={4}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>
            Notes <span className="text-muted-foreground/60 normal-case">(optional)</span>
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. cap timeline at 4 weeks"
            rows={2}
            className={inputClass}
          />
        </div>
      </div>

      {isEdited ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Edited from the original — the source proposal is preserved for audit.
        </p>
      ) : null}

      <MutationError mutation={resolve} verb="resolve" />

      <div className="flex items-center justify-between mt-4">
        <p className="text-[11px] text-muted-foreground">Both sides resume via executor in ≤30s.</p>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="h-9 px-4 rounded text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {resolve.isPending ? "Resolving…" : "Resolve & dispatch"}
        </button>
      </div>
    </section>
  );
}

function ModeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`h-8 px-3 rounded text-xs font-medium border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border hover:bg-secondary text-muted-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function ResolvedView({ esc }: { esc: EscalationReviewDetail }) {
  const r = esc.resolution_proposal;
  const cancelled = esc.status === "cancelled";
  return (
    <section
      className={`rounded-lg border p-5 mb-6 ${
        cancelled ? "border-border bg-muted/30" : "border-emerald-500/30 bg-emerald-500/5"
      }`}
    >
      <h2
        className={`text-[11px] uppercase tracking-wider mb-3 font-medium ${
          cancelled ? "text-muted-foreground" : "text-emerald-600 dark:text-emerald-400"
        }`}
      >
        {cancelled ? "Cancelled" : "Resolution"}
      </h2>
      {r ? (
        <>
          <div className="text-sm font-medium mb-1">{r.title}</div>
          <div className="text-sm text-foreground/90">
            <ChatMarkdown content={r.description} />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Source: {r.source}
            {typeof r.source_index === "number" ? ` · #${r.source_index + 1}` : ""}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground italic">No resolution recorded.</p>
      )}
      {esc.resolution_notes ? (
        <div className="mt-3 pt-3 border-t border-border/40">
          <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-medium">
            Notes
          </h3>
          <p className="text-sm text-foreground/80">{esc.resolution_notes}</p>
        </div>
      ) : null}
    </section>
  );
}
