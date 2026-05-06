"use client";

import { AlertTriangle, Bot } from "lucide-react";
import { useAgents } from "@/lib/hooks/use-agents";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";
import { TeamOrbit } from "@/components/team-orbit";

/**
 * /agents — visual orbit of the user's team. Wraps the shared
 * <TeamOrbit /> with a page header so the route has a context line.
 * Same component renders compact on the dashboard, so both surfaces
 * speak one visual language.
 */
export function AgentsClient() {
  const { isError } = useAgents();

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
          <Shell icon={AlertTriangle} title="Couldn't load agents" />
        ) : (
          <>
            <header className="mb-6">
              <h1 className="text-xl font-semibold tracking-tight">Your team</h1>
              <p className="mt-1 text-sm text-muted-foreground max-w-prose">
                Your team agent at the center, specialists orbiting around
                them. Click any agent to drill into their persona, domain,
                and recent sessions.
              </p>
            </header>
            <TeamOrbit size="large" />
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
