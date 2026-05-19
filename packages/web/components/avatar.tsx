import { createAvatar } from "@dicebear/core";
import { botttsNeutral, thumbs } from "@dicebear/collection";
import { cn } from "@/lib/utils";
import type { HierarchyLevel } from "@beevibe/core";

const HIER_BG = {
  ic: "agent-avatar-glass agent-avatar-glass-ic",
  team: "agent-avatar-glass agent-avatar-glass-team",
  org: "agent-avatar-glass agent-avatar-glass-org",
} as const;

const PRESENCE_BG = {
  running: "bg-status-running",
  idle: "bg-muted-foreground",
  off: "bg-secondary",
} as const;

const AVATAR_BACKGROUND: Record<HierarchyLevel, string[]> = {
  ic: ["60a5fa", "64748b", "94a3b8"],
  team: ["facc15", "fbbf24", "f59e0b"],
  org: ["fb923c", "f59e0b", "94a3b8"],
};

const AVATAR_EYES: Array<"eva" | "happy" | "round" | "sensor" | "shade01"> = [
  "eva",
  "happy",
  "round",
  "sensor",
  "shade01",
];
const AVATAR_MOUTH: Array<"diagram" | "smile01" | "smile02" | "square01" | "square02"> = [
  "diagram",
  "smile01",
  "smile02",
  "square01",
  "square02",
];

const PERSON_BACKGROUND = ["fef3c7", "dbeafe", "e2e8f0", "fed7aa"];
const PERSON_SHAPE = ["f88c49", "1c799f", "facc15", "0a5b83", "f1f4dc"];
const PERSON_FEATURE = ["111827", "ffffff"];
const avatarSrcCache = new Map<string, string>();

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
  const isPerson = kind === "person";
  const avatarSrc = isPerson
    ? createPersonAvatarSrc({ initial, label, specialization })
    : createAgentAvatarSrc({ initial, kind, label, specialization });

  return (
    <span className={cn("relative inline-block", className)}>
      <span
        style={baseStyle}
        className={cn(
          "inline-flex items-center justify-center font-semibold shrink-0",
          isPerson
            ? "person-avatar-glass"
            : HIER_BG[kind],
        )}
      >
        <span
          aria-hidden
          className="dicebear-avatar-image"
          style={{ backgroundImage: `url("${avatarSrc}")` }}
        />
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

function createAgentAvatarSrc({
  initial,
  kind,
  label,
  specialization,
}: {
  initial: string;
  kind: HierarchyLevel;
  label?: string;
  specialization?: string;
}) {
  const seed = [kind, label || initial, specialization].filter(Boolean).join(":");
  const cacheKey = `${kind}:${seed}`;
  const cachedSrc = avatarSrcCache.get(cacheKey);
  if (cachedSrc) return cachedSrc;

  const avatarSrc = createAvatar(botttsNeutral, {
    seed,
    backgroundColor: AVATAR_BACKGROUND[kind],
    eyes: AVATAR_EYES,
    mouth: AVATAR_MOUTH,
    radius: 18,
    scale: 84,
  }).toDataUri();
  avatarSrcCache.set(cacheKey, avatarSrc);

  return avatarSrc;
}

function createPersonAvatarSrc({
  initial,
  label,
  specialization,
}: {
  initial: string;
  label?: string;
  specialization?: string;
}) {
  const seed = ["person", label || initial, specialization].filter(Boolean).join(":");
  const cacheKey = `person:${seed}`;
  const cachedSrc = avatarSrcCache.get(cacheKey);
  if (cachedSrc) return cachedSrc;

  const avatarSrc = createAvatar(thumbs, {
    seed,
    backgroundColor: PERSON_BACKGROUND,
    shapeColor: PERSON_SHAPE,
    eyesColor: PERSON_FEATURE,
    mouthColor: PERSON_FEATURE,
    radius: 50,
    scale: 86,
  }).toDataUri();
  avatarSrcCache.set(cacheKey, avatarSrc);

  return avatarSrc;
}
