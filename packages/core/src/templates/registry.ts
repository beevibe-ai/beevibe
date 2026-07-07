import { CTO_BEE_TEMPLATE } from "./cto-bee.js";
import type { AgentTemplate } from "./types.js";

/**
 * Registered agent templates. Keyed by `AgentTemplate.name` so callers
 * can look up by the value stored in `agent.agent_template`.
 *
 * Adding a template:
 *   1. Define it in its own file under this dir.
 *   2. Add it here.
 *   3. The compose pipeline picks it up automatically — no other call
 *      sites need to change.
 */
const TEMPLATES: Readonly<Record<string, AgentTemplate>> = Object.freeze({
  [CTO_BEE_TEMPLATE.name]: CTO_BEE_TEMPLATE,
});

export function getAgentTemplate(name: string | null | undefined): AgentTemplate | null {
  if (!name) return null;
  return TEMPLATES[name] ?? null;
}

export function listAgentTemplates(): readonly AgentTemplate[] {
  return Object.values(TEMPLATES);
}

export function isKnownAgentTemplate(name: string | null | undefined): boolean {
  return getAgentTemplate(name) != null;
}
