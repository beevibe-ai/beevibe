import { cn } from "@/lib/utils";
import type { HierarchyLevel } from "@beevibe/core";

type AgentIconVariant =
  | "team"
  | "org"
  | "conversation"
  | "document"
  | "pitch"
  | "code"
  | "data"
  | "research"
  | "design"
  | "memory"
  | "ops"
  | "generic";

const HIER_BG = {
  ic: "bg-hier-ic/12 text-hier-ic",
  team: "bg-primary text-primary-foreground",
  org: "bg-hier-org/12 text-hier-org",
} as const;

const PRESENCE_BG = {
  running: "bg-status-running",
  idle: "bg-muted-foreground",
  off: "bg-secondary",
} as const;

interface Props {
  initial: string;
  kind: HierarchyLevel | "person";
  label?: string;
  specialization?: string;
  size?: number;
  presence?: "running" | "idle" | "off";
  className?: string;
}

export function Avatar({
  initial,
  kind,
  label,
  specialization,
  size = 28,
  presence,
  className,
}: Props) {
  const baseStyle = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.39)) };
  const dotSize = Math.max(6, Math.round(size * 0.32));
  const iconSize = Math.max(13, Math.round(size * 0.58));
  const isPerson = kind === "person";
  const icon = isPerson ? undefined : pickAgentIcon(kind, label, specialization);
  return (
    <span className={cn("relative inline-block", className)}>
      <span
        style={baseStyle}
        className={cn(
          "rounded-full inline-flex items-center justify-center font-semibold shrink-0",
          isPerson
            ? "bg-secondary text-foreground border border-border"
            : HIER_BG[kind],
        )}
      >
        {isPerson ? initial : (
          <AgentIconMark variant={icon ?? "generic"} size={iconSize} />
        )}
      </span>
      {presence ? (
        <span
          style={{ width: dotSize, height: dotSize }}
          className={cn(
            "absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-background",
            PRESENCE_BG[presence],
            presence === "running" && "animate-pulse-breathe",
          )}
        />
      ) : null}
    </span>
  );
}

function pickAgentIcon(
  kind: HierarchyLevel,
  label?: string,
  specialization?: string,
): AgentIconVariant {
  const text = `${label ?? ""} ${specialization ?? ""}`.toLowerCase();
  if (kind === "org") return "org";
  if (kind === "team") return "team";
  if (/\b(chat|conversation|conversational|dialog|message|ui|ux|interface)\b/.test(text)) {
    return "conversation";
  }
  if (/\b(pdf|document|doc|extract|extraction|ocr|table|tables|parse|parser)\b/.test(text)) {
    return "document";
  }
  if (/\b(pitch|narrative|story|deck|slide|fundraising|founder)\b/.test(text)) {
    return "pitch";
  }
  if (/\b(code|coding|engineer|developer|frontend|backend|fullstack|repo|test)\b/.test(text)) {
    return "code";
  }
  if (/\b(data|analytics|metric|dashboard|sql|warehouse|pipeline)\b/.test(text)) {
    return "data";
  }
  if (/\b(research|search|synthesis|market|competitive|analysis)\b/.test(text)) {
    return "research";
  }
  if (/\b(design|brand|visual|prototype|product)\b/.test(text)) {
    return "design";
  }
  if (/\b(memory|knowledge|archive|facts|taxonomy)\b/.test(text)) {
    return "memory";
  }
  if (/\b(ops|operations|workflow|process|automation|support)\b/.test(text)) {
    return "ops";
  }
  return "generic";
}

function AgentIconMark({
  variant,
  size,
}: {
  variant: AgentIconVariant;
  size: number;
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {variant === "team" ? (
        <>
          <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" opacity="0.2" />
          <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
          <circle cx="7" cy="7.4" r="1.8" />
          <circle cx="17" cy="7.4" r="1.8" />
          <circle cx="12" cy="18" r="1.8" />
          <path d="M8.4 8.8 10.3 10.4M15.6 8.8 13.7 10.4M12 15.2v1" />
        </>
      ) : variant === "org" ? (
        <>
          <path d="M7 19V9.2L12 6l5 3.2V19" />
          <path d="M9.2 19v-3.5h5.6V19M9.5 11h.1M14.4 11h.1M9.5 14h.1M14.4 14h.1" />
          <path d="M5.5 19h13" />
        </>
      ) : variant === "conversation" ? (
        <>
          <path d="M6.2 8.2h8.1a3 3 0 0 1 3 3v1.3a3 3 0 0 1-3 3H11l-3.4 2.4v-2.4H6.2a3 3 0 0 1-3-3v-1.3a3 3 0 0 1 3-3Z" />
          <path d="M8.2 11.1h5.8M8.2 13.1h3.8" />
          <path d="M16.5 7.2c2.1.3 3.3 1.7 3.3 3.6v1" opacity="0.55" />
        </>
      ) : variant === "document" ? (
        <>
          <path d="M7 4.8h6.4L17 8.4v10.8H7z" />
          <path d="M13.2 4.9v3.7h3.6M9.4 11h5.2M9.4 13.6h5.2M9.4 16.2h2.4" />
          <path d="M15 15.2 18 18.2M15.8 14a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
        </>
      ) : variant === "pitch" ? (
        <>
          <path d="M5.5 6.4h13v9.2h-13zM8 18.8h8M12 15.6v3.2" />
          <path d="M8.3 12.8 10.7 10l2 1.8 3-3.4" />
          <path d="M15.7 8.4v3h-3" />
        </>
      ) : variant === "code" ? (
        <>
          <path d="M9.5 7.5 5.5 12l4 4.5M14.5 7.5l4 4.5-4 4.5" />
          <path d="m13 6.5-2 11" />
        </>
      ) : variant === "data" ? (
        <>
          <path d="M5.5 8.2c0-1.7 3-3 6.5-3s6.5 1.3 6.5 3-3 3-6.5 3-6.5-1.3-6.5-3Z" />
          <path d="M5.5 8.2v4c0 1.7 3 3 6.5 3s6.5-1.3 6.5-3v-4" />
          <path d="M5.5 12.2v3.6c0 1.7 3 3 6.5 3s6.5-1.3 6.5-3v-3.6" />
        </>
      ) : variant === "research" ? (
        <>
          <circle cx="10.8" cy="10.8" r="4.6" />
          <path d="m14.2 14.2 4.3 4.3M9.2 10.6l1.2 1.2 2.4-2.9" />
        </>
      ) : variant === "design" ? (
        <>
          <path d="M6.2 15.8 15.8 6.2a2.1 2.1 0 0 1 3 3l-9.6 9.6-4 1Z" />
          <path d="m14.5 7.5 2 2M6.8 15.2l2 2" />
        </>
      ) : variant === "memory" ? (
        <>
          <path d="M7 6.8a3 3 0 0 1 5-2.2 3 3 0 0 1 5 2.2v9.1a3.1 3.1 0 0 1-3.1 3.1H10A3.1 3.1 0 0 1 7 15.9Z" />
          <path d="M12 4.6V19M9.5 9h5M9.5 12h5M9.5 15h3" />
        </>
      ) : variant === "ops" ? (
        <>
          <path d="M12 5v3M12 16v3M5 12h3M16 12h3" />
          <path d="M8 8.1 10.1 10M15.9 8.1 14 10M8 15.9l2.1-1.9M15.9 15.9 14 14" />
          <circle cx="12" cy="12" r="3.2" />
        </>
      ) : (
        <>
          <path d="M12 4.8 17.8 8v6.6L12 19.2l-5.8-4.6V8z" />
          <path d="M12 8.3v7.4M8.8 10.1l6.4 3.8M15.2 10.1l-6.4 3.8" />
        </>
      )}
    </svg>
  );
}
