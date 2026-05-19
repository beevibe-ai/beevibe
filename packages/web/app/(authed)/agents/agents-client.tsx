"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Bot, LayoutGrid, List, Maximize2, Minus, Plus } from "lucide-react";
import type { PanZoomTransform } from "@/lib/hooks/use-pan-zoom";
import { useAgentNetwork } from "@/lib/hooks/use-agent-network";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";
import { TeamOrbit } from "@/components/team-orbit";
import { AgentDetailPanel } from "@/components/agents/agent-detail-panel";
import { AgentsListView } from "@/components/agents/agents-list-view";
import { PageHeader } from "@/components/page-header";
import { usePanZoom } from "@/lib/hooks/use-pan-zoom";

type ViewMode = "orbit" | "list";

// List is the default — most visits to /agents are about checking or
// changing per-agent config (runtime, model, review policy), which the
// list view exposes directly. The orbit view is the spatial alternative
// for "look at the shape of my team," kept one click away behind
// ?view=orbit.
function parseView(raw: string | null | undefined): ViewMode {
  return raw === "orbit" ? "orbit" : "list";
}

/**
 * /agents — pan/zoom canvas of the agent network.
 *
 * Self orbit at the canvas origin (0,0); peer orbits arranged radially
 * around it. The whole world is wrapped in a transformable layer so
 * the user can drag to pan and wheel/pinch to zoom — same gestures
 * Figma / Excalidraw / Miro use, so the affordance reads without
 * onboarding.
 *
 * Clicking an agent opens its detail in a Notion-style peek panel
 * anchored to the right of the canvas. State is mirrored in the URL
 * via `?p=<agentId>` so the panel survives reload + back-button.
 */
export function AgentsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedAgentId = searchParams?.get("p") ?? undefined;
  const view = parseView(searchParams?.get("view"));

  // Build a URL that preserves the *other* params while overriding one
  // we care about. Used by both the peek panel toggle (`?p=`) and the
  // orbit/list view switcher (`?view=`). Without this, swapping views
  // would clobber the currently-open peek panel and vice versa.
  const buildHref = useCallback(
    (patch: Partial<Record<"p" | "view", string | null>>) => {
      const sp = new URLSearchParams(searchParams?.toString() ?? "");
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) sp.delete(key);
        else if (value !== undefined) sp.set(key, value);
      }
      const qs = sp.toString();
      return qs ? `/agents?${qs}` : "/agents";
    },
    [searchParams],
  );

  const openAgent = useCallback(
    (agentId: string) => {
      // Replace, not push — opening the panel shouldn't make the back
      // button bounce through every agent the user clicked. Closing
      // (cleared param) DOES push so back button restores the panel.
      router.replace(buildHref({ p: agentId }), { scroll: false });
    },
    [router, buildHref],
  );

  const closeAgent = useCallback(() => {
    router.push(buildHref({ p: null }), { scroll: false });
  }, [router, buildHref]);

  const setView = useCallback(
    (next: ViewMode) => {
      // List is the default; encode it by *removing* the param so the
      // common case has a clean URL.
      router.replace(buildHref({ view: next === "list" ? null : "orbit" }), {
        scroll: false,
      });
    },
    [router, buildHref],
  );

  const { data, isLoading, isError } = useAgentNetwork();
  const selfAgents = data?.self ?? [];

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden bg-gradient-to-b from-background to-secondary/20">
      <PageHeader
        title="Agents"
        subtitle="Your team and how each one is configured."
      >
        <ViewToggle view={view} onChange={setView} />
      </PageHeader>

      <div className="relative flex-1 overflow-hidden">
      {!isApiConfigured ? (
        <CenteredShell
          icon={Bot}
          title="API not configured"
          description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load agents."
        />
      ) : isError ? (
        <CenteredShell icon={AlertTriangle} title="Couldn't load the network" />
      ) : view === "list" ? (
        <AgentsListView
          agents={selfAgents}
          onSelect={openAgent}
          selectedAgentId={selectedAgentId}
        />
      ) : (
        <OrbitCanvas data={data} isLoading={isLoading} onSelect={openAgent} />
      )}

      {selectedAgentId ? (
        <AgentDetailPanel agentId={selectedAgentId} onClose={closeAgent} />
      ) : null}
      </div>
    </div>
  );
}

/**
 * Orbit canvas — extracted so `usePanZoom` is only instantiated when
 * orbit is the active view. Keeping the hook at the parent level meant
 * its mount-time useEffects ran with `containerRef.current === null`
 * (because the list was the default branch), so wheel/pointer handlers
 * were never bound — making the canvas un-draggable until you forced a
 * remount.
 */
function OrbitCanvas({
  data,
  isLoading,
  onSelect,
}: {
  data: ReturnType<typeof useAgentNetwork>["data"];
  isLoading: boolean;
  onSelect: (agentId: string) => void;
}) {
  const panZoom = usePanZoom({ minScale: 0.4, maxScale: 2.5 });
  const peers = data?.peers ?? [];

  return (
    <>
      <GestureHint transform={panZoom.transform} />

      {/* Pan/zoom container — captures wheel + pointer, transforms
          the inner world. Cursor hint reads as "draggable canvas". */}
      <div
        ref={panZoom.containerRef}
        className="absolute inset-0 cursor-grab touch-none select-none"
        // Touch-action none + select-none keep mobile pan from
        // scrolling the page or selecting card text mid-drag.
      >
        <div
          className="absolute left-1/2 top-1/2"
          style={panZoom.style}
        >
          {/* Self orbit anchored at world origin (0,0); the parent
              div is already centered via left-50%/top-50%, so a
              translate(-50%,-50%) on the orbit's wrapper keeps it
              visually centered when the canvas is at scale 1 with
              zero pan. */}
          <div
            className="network-orbit-layer network-orbit-layer-self absolute"
            style={{ left: 0, top: 0, transform: "translate(-50%, -50%)" }}
          >
            <TeamOrbit
              agents={data?.self}
              size="large"
              loading={isLoading}
              onSelect={onSelect}
            />
          </div>

          {peers.map((peer, i) => {
            const pos = satellitePosition(i, peers.length);
            return (
              <div
                key={peer.owner_id}
                className="network-orbit-layer network-orbit-layer-peer absolute flex flex-col items-center"
                style={{
                  left: `${pos.x}px`,
                  top: `${pos.y}px`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                <TeamOrbit
                  agents={peer.agents}
                  size="satellite"
                  onSelect={onSelect}
                />
              </div>
            );
          })}
        </div>
      </div>

      <CanvasControls
        scale={panZoom.transform.scale}
        onZoomIn={() => panZoom.zoomBy(1.25)}
        onZoomOut={() => panZoom.zoomBy(0.8)}
        onReset={panZoom.reset}
      />
    </>
  );
}

function GestureHint({ transform }: { transform: PanZoomTransform }) {
  // Small bottom-left chip that whispers the gesture model on first
  // load. Fades itself out the moment the user pans or zooms — at that
  // point they've discovered it, so the hint is just noise. Also
  // auto-dismisses after a few seconds so it doesn't linger if the
  // user is just reading.
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const inT = setTimeout(() => setVisible(true), 400);
    const outT = setTimeout(() => setDismissed(true), 7000);
    return () => {
      clearTimeout(inT);
      clearTimeout(outT);
    };
  }, []);

  useEffect(() => {
    if (dismissed) return;
    const moved =
      transform.x !== 0 || transform.y !== 0 || transform.scale !== 1;
    if (moved) setDismissed(true);
  }, [transform.x, transform.y, transform.scale, dismissed]);

  if (dismissed && !visible) return null;

  return (
    <div
      className={`absolute bottom-6 left-6 z-10 pointer-events-none transition-all duration-500 ease-out motion-reduce:transition-none ${
        visible && !dismissed
          ? "opacity-100 translate-y-0"
          : "opacity-0 translate-y-1"
      }`}
      data-pan="ignore"
    >
      <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/80 backdrop-blur-sm px-3 py-1 text-[11px] text-muted-foreground shadow-sm">
        <span>drag</span>
        <span className="text-border" aria-hidden>·</span>
        <span>scroll to zoom</span>
      </div>
    </div>
  );
}

/**
 * Place satellite #i out of n equally around the world origin, starting
 * at 3 o'clock. Distance is tuned so a self orbit (radius ~290) and a
 * satellite orbit (radius ~165) keep ~80px of breathing room between
 * their card rings even when both have wrapping/wide cards.
 */
function satellitePosition(i: number, n: number): { x: number; y: number } {
  const distance = 660;
  const angle = (i / n) * 2 * Math.PI;
  return {
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
  };
}

function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (next: ViewMode) => void;
}) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-full border border-border bg-card/90 backdrop-blur-sm shadow-sm p-0.5"
      data-pan="ignore"
    >
      <ToggleButton
        active={view === "list"}
        onClick={() => onChange("list")}
        label="List"
        title="List view — manage runtime, model, review policy"
      >
        <List className="h-3.5 w-3.5" />
      </ToggleButton>
      <ToggleButton
        active={view === "orbit"}
        onClick={() => onChange("orbit")}
        label="Orbit"
        title="Orbit view — pan and zoom the network"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
      </ToggleButton>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  label,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={
        "h-7 px-2.5 inline-flex items-center gap-1.5 rounded-full text-xs font-medium cursor-pointer " +
        (active
          ? "glassy-chip"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors")
      }
    >
      {children}
      <span className="leading-none">{label}</span>
    </button>
  );
}

function CanvasControls({
  scale,
  onZoomIn,
  onZoomOut,
  onReset,
}: {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  return (
    <div
      className="absolute bottom-6 right-6 z-10 inline-flex items-center gap-1 rounded-full border border-border bg-card/90 backdrop-blur-sm shadow-sm px-1.5 py-1"
      data-pan="ignore"
    >
      <CanvasButton onClick={onZoomOut} aria-label="Zoom out" title="Zoom out">
        <Minus className="h-3.5 w-3.5" />
      </CanvasButton>
      <button
        type="button"
        onClick={onReset}
        title="Reset view"
        className="h-7 px-2 inline-flex items-center justify-center text-[11px] font-mono text-muted-foreground hover:text-foreground tabular-nums cursor-pointer"
      >
        {Math.round(scale * 100)}%
      </button>
      <CanvasButton onClick={onZoomIn} aria-label="Zoom in" title="Zoom in">
        <Plus className="h-3.5 w-3.5" />
      </CanvasButton>
      <span className="w-px h-4 bg-border mx-0.5" aria-hidden />
      <CanvasButton onClick={onReset} aria-label="Recenter" title="Recenter">
        <Maximize2 className="h-3.5 w-3.5" />
      </CanvasButton>
    </div>
  );
}

function CanvasButton({
  onClick,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 w-7 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors"
      {...rest}
    >
      {children}
    </button>
  );
}

function CenteredShell({
  icon,
  title,
  description,
}: {
  icon: typeof Bot;
  title: string;
  description?: string;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="rounded-lg border border-dashed border-border w-full max-w-md">
        <EmptyState icon={icon} title={title} description={description} />
      </div>
    </div>
  );
}
