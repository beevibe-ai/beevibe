"use client";

import { AlertTriangle, Bot } from "lucide-react";
import { useAgentNetwork } from "@/lib/hooks/use-agent-network";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";
import { TeamOrbit } from "@/components/team-orbit";

/**
 * /agents — full network view. Caller's team orbit at the top; below,
 * one orbit per peer team they collaborate with through shared rooms.
 *
 * Peer set is room-derived: every distinct other-owner whose agents
 * the caller has met in a room shows up. The pitch lives or dies on
 * cross-team visibility, so this surface earns its own page.
 */
export function AgentsClient() {
  const { data, isLoading, isError } = useAgentNetwork();

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto pt-8 pb-12 px-6">
        {!isApiConfigured ? (
          <Shell
            icon={Bot}
            title="API not configured"
            description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load agents."
          />
        ) : isError ? (
          <Shell icon={AlertTriangle} title="Couldn't load the network" />
        ) : (
          <>
            <header className="mb-6">
              <h1 className="text-xl font-semibold tracking-tight">Your team</h1>
              <p className="mt-1 text-sm text-muted-foreground max-w-prose">
                Your team agent at the center, specialists orbiting around them.
                Click any agent to drill into their persona, domain, and recent
                sessions.
              </p>
            </header>

            <TeamOrbit
              agents={data?.self}
              size="large"
              loading={isLoading}
            />

            {data && data.peers.length > 0 ? (
              <section className="mt-16">
                <header className="mb-6">
                  <h2 className="text-base font-semibold tracking-tight">
                    People you collaborate with
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground max-w-prose">
                    Other teams you co-attend rooms with. Each orbit is one
                    teammate&apos;s team — click any agent to peek at their
                    persona and domain.
                  </p>
                </header>
                <div className="space-y-12">
                  {data.peers.map((peer) => (
                    <div key={peer.owner_id}>
                      <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
                        {peer.owner_label}&apos;s team
                      </h3>
                      <TeamOrbit agents={peer.agents} size="compact" />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function Shell({
  icon,
  title,
  description,
}: {
  icon: typeof Bot;
  title: string;
  description?: string;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border">
      <EmptyState icon={icon} title={title} description={description} />
    </div>
  );
}
