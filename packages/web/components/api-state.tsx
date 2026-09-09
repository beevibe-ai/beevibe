"use client";

import type { LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

/**
 * One home for the two messages every API-backed surface shows when it
 * can't render real data: "the browser has no API URL" and "the fetch
 * failed". Both used to be written out at each call site, and the copy
 * had drifted badly enough to be misleading rather than merely untidy:
 *
 *  - The same unconfigured-API condition was titled "API not configured",
 *    "Web isn't configured", "Chat not connected", "Dashboard not
 *    connected", "Memory eval not connected" — and, on the mesh, memory
 *    and promotions pages, "No mesh asks yet" / "No facts learned yet" /
 *    "No promotions yet". Those last three report an *empty account* for
 *    what is actually an unconfigured build, which sends the reader
 *    looking for missing data instead of a missing env var.
 *  - The process to start was variously "the api server", "the API
 *    server" and "the MCP server". There is one process; it had three
 *    names.
 *
 * Deriving both strings from a `subject` here means a new page can't
 * word them a sixth way. Layout deliberately stays with the caller —
 * these states appear inside a card, a table row, a flex-centered
 * canvas and a full-page shell, and forcing one wrapper on all of them
 * is what pushed callers into hand-rolling the copy in the first place.
 */
export function notConfiguredCopy(subject: string): {
  title: string;
  description: string;
} {
  return {
    title: "API not configured",
    description: `Set NEXT_PUBLIC_BV_API_URL and run the API server to load ${subject}.`,
  };
}

/**
 * Copy for a fetch that settled without usable data. `id` is echoed back
 * so a failure is identifiable from a screenshot; omit it on list
 * surfaces, where there's no single row to name.
 */
export function fetchErrorCopy(
  noun: string,
  id?: string,
): { title: string; description: string | undefined } {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  return {
    title: `Couldn't load ${noun}`,
    description: id ? `${Noun} ${id} could not be fetched. Check the API server logs.` : undefined,
  };
}

/**
 * The unconfigured-API empty state. `subject` completes the sentence
 * "…run the API server to load ___" — so pass what the page shows
 * ("mesh activity", "this task"), not a bare noun.
 */
export function NotConfigured({
  icon,
  subject,
  className,
}: {
  icon?: LucideIcon;
  subject: string;
  className?: string;
}) {
  const { title, description } = notConfiguredCopy(subject);
  return <EmptyState icon={icon} title={title} description={description} className={className} />;
}
