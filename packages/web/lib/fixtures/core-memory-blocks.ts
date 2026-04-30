export interface CoreBlockDisplay {
  id: string;
  agent_id: string;
  block_name: string;
  content: string;
  char_count: number;
  char_limit: number;
  is_system: boolean;
  updated_label: string;
}

export const fixtureCoreBlocks: Record<string, CoreBlockDisplay[]> = {
  agt_ic1: [
    {
      id: "blk_ic1_persona",
      agent_id: "agt_ic1",
      block_name: "persona",
      content:
        "You are a senior engineer specialized in authentication flows. You think in terms of trust boundaries: who is asserting identity, who is verifying, what tokens are crossing which network edges, what's signed vs encrypted. You prefer OAuth 2.1 over implicit-grant patterns; you treat session storage as a security primitive, not a convenience.",
      char_count: 1376,
      char_limit: 2000,
      is_system: true,
      updated_label: "edited 2 weeks ago",
    },
    {
      id: "blk_ic1_domain",
      agent_id: "agt_ic1",
      block_name: "domain",
      content:
        "Auth surface for this codebase: bv_a_ agent keys + bv_u_ user keys. Both stored on Person.api_key column. Sessions identified by bv_session HttpOnly cookie. OAuth being added for external client authentication. Token storage on person.oauth_tokens (JSONB).",
      char_count: 1728,
      char_limit: 2000,
      is_system: false,
      updated_label: "edited 4d ago",
    },
    {
      id: "blk_ic1_constraints",
      agent_id: "agt_ic1",
      block_name: "constraints",
      content:
        "Never log full bearer tokens — log first-8-chars with hash suffix only. PKCE mandatory for public clients. Refresh-token rotation per OWASP. Auth changes require integration tests covering happy path + denied-consent + expired-state + refresh paths.",
      char_count: 1860,
      char_limit: 2000,
      is_system: false,
      updated_label: "edited 6d ago",
    },
  ],
};

export const fixtureAgentMetrics: Record<string, { sessions: number; sessions_change: number; facts: number; merges: number; promoted: number }> = {
  agt_ic1: { sessions: 47, sessions_change: 3, facts: 23, merges: 8, promoted: 4 },
};
