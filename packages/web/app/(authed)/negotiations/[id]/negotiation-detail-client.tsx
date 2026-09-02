"use client";

import Link from "next/link";
import { MessagesSquare, Scale } from "lucide-react";
import { MeshBackLink } from "@/components/detail/mesh-back-link";
import { useNegotiation } from "@/lib/hooks/use-negotiations";
import { ChatMarkdown } from "@/components/chat/markdown";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { DetailGate } from "@/components/detail/detail-gate";
import { FooterField } from "@/components/detail/footer-field";
import { DetailFooter } from "@/components/detail/detail-footer";
import { NegotiationStatusPill } from "@/components/detail/status-pill";
import { Skeleton } from "@/components/skeleton";
import { formatRelativeTime } from "@/lib/format";
import type {
  NegotiationDecision,
  NegotiationReviewDetail,
  NegotiationRoundDetail,
} from "@/lib/types/negotiations";

export function NegotiationDetailClient({ negotiationId }: { negotiationId: string }) {
  const query = useNegotiation(negotiationId);

  return (
    <DetailGate
      nav={<MeshBackLink />}
      icon={MessagesSquare}
      noun="negotiation"
      id={negotiationId}
      query={query}
      skeleton={
        <>
          <Skeleton className="h-7 w-40 mb-4" />
          <Skeleton className="h-24 w-full rounded-lg mb-6" />
          <div className="space-y-3">
            <Skeleton className="h-32 w-full rounded-lg" />
            <Skeleton className="h-32 w-full rounded-lg" />
          </div>
        </>
      }
    >
      {(data) => <NegotiationDetailLoaded neg={data.negotiation} />}
    </DetailGate>
  );
}

const DECISION_BADGE: Record<NegotiationDecision, string> = {
  propose: "bg-status-running/10 text-status-running",
  counter: "bg-status-review/10 text-status-review",
  accept: "bg-status-done/10 text-status-done",
  reject: "bg-status-failed/10 text-status-failed",
};

function DecisionBadge({ decision }: { decision: NegotiationDecision }) {
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 rounded text-[10px] uppercase tracking-wider font-medium ${DECISION_BADGE[decision]}`}
    >
      {decision}
    </span>
  );
}

function NegotiationDetailLoaded({ neg }: { neg: NegotiationReviewDetail }) {
  const nameForAgent = (id: string) =>
    id === neg.initiator_agent_id
      ? neg.initiator_agent_name
      : id === neg.counterparty_agent_id
        ? neg.counterparty_agent_name
        : id;

  return (
    <>
      <header className="mb-6">
        <div className="flex items-start justify-between gap-6 mb-3">
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight leading-tight">Negotiation</h1>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {neg.initiator_agent_name}
              <span className="text-muted-foreground/50 mx-1.5">↔</span>
              {neg.counterparty_agent_name}
            </p>
          </div>
          <NegotiationStatusPill status={neg.status} />
        </div>

        {neg.escalation_id ? (
          <Link
            href={`/escalations/${neg.escalation_id}`}
            className="block rounded-lg border border-status-review/40 bg-status-review/5 p-3 hover:bg-status-review/10 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Scale className="h-3.5 w-3.5 text-status-review shrink-0" />
              <span className="text-xs text-status-review font-medium">
                Escalated to humans — see resolution
              </span>
              <span className="ml-auto text-[11px] text-muted-foreground font-mono">
                {neg.escalation_id}
              </span>
            </div>
          </Link>
        ) : null}
      </header>

      <section>
        <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
          Rounds <span className="text-muted-foreground/70 tabular-nums">{neg.rounds.length}</span>
        </h2>
        {neg.rounds.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No rounds recorded.</p>
        ) : (
          <ul className="space-y-3">
            {neg.rounds.map((round) => (
              <RoundCard
                key={round.id}
                round={round}
                agentName={nameForAgent(round.from_agent_id)}
              />
            ))}
          </ul>
        )}
      </section>

      <DetailFooter>
        <FooterField label="ID">
          <ClickToCopyId id={neg.id} />
        </FooterField>
        {neg.task_id ? (
          <FooterField label="Task">
            <Link
              href={`/tasks/${neg.task_id}`}
              className="font-mono hover:text-foreground transition-colors"
            >
              {neg.task_id}
            </Link>
          </FooterField>
        ) : null}
        <FooterField label="Rounds">
          {neg.rounds_completed}/{neg.max_rounds}
        </FooterField>
        <FooterField label="Created">{formatRelativeTime(neg.created_at)}</FooterField>
        {neg.updated_at !== neg.created_at ? (
          <FooterField label="Updated">{formatRelativeTime(neg.updated_at)}</FooterField>
        ) : null}
      </DetailFooter>
    </>
  );
}

function RoundCard({
  round,
  agentName,
}: {
  round: NegotiationRoundDetail;
  agentName: string;
}) {
  return (
    <li className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground tabular-nums">
          Round {round.round_number}
        </span>
        <span className="text-sm font-medium text-foreground truncate">{agentName}</span>
        <DecisionBadge decision={round.decision} />
        <span className="ml-auto text-[11px] text-muted-foreground/70 shrink-0">
          {formatRelativeTime(round.sent_at)}
        </span>
      </div>
      <div className="text-sm text-foreground/90">
        <ChatMarkdown content={round.message} />
      </div>
    </li>
  );
}
