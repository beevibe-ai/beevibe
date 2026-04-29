export interface MeshAsk {
  id: string;
  caller: string;
  target: string;
  type: "ask" | "negotiate" | "blocker";
  status: "in_flight" | "succeeded" | "blocked";
  duration_label: string;
  intent: string;
  response?: { agent: string; content: string };
  chain_depth: string;
  source_session: string;
  source_task_short_id: string;
  source_task_age?: string;
}

export const fixtureMeshAsks: MeshAsk[] = [
  {
    id: "ask_1",
    caller: "ic-agent-1",
    target: "db-agent",
    type: "ask",
    status: "in_flight",
    duration_label: "in flight · 4s",
    intent:
      "What's the schema for refresh-token storage? Need a column that can hold the encrypted blob plus rotation metadata, with a unique index by user_id.",
    chain_depth: "1/4",
    source_session: "sess_a8c2",
    source_task_short_id: "T-1029",
  },
  {
    id: "ask_2",
    caller: "ic-agent-3",
    target: "team-alpha",
    type: "negotiate",
    status: "in_flight",
    duration_label: "in flight · 11s",
    intent:
      "Should the task-repo refactor preserve the existing index idx_task_dispatch verbatim, or rebuild as a partial index? Performance budget for dispatch query is 5ms p95.",
    chain_depth: "1/4",
    source_session: "sess_b4f1",
    source_task_short_id: "T-1031",
  },
  {
    id: "ask_3",
    caller: "ic-agent-1",
    target: "db-agent",
    type: "ask",
    status: "succeeded",
    duration_label: "8s",
    intent:
      "Is the new auth path safe given how we're handling token refresh? Walking through: PKCE verifier, /token exchange, then writing the encrypted refresh blob.",
    response: {
      agent: "db-agent",
      content:
        "Refresh blob fine in `refresh_token` table — but you need FOR UPDATE SKIP LOCKED on read for the rotation flow, or two concurrent rotations race the increment. Patch in db_helpers.ts:142.",
    },
    chain_depth: "1/4",
    source_session: "sess_3a8c",
    source_task_short_id: "T-1014",
    source_task_age: "18m ago",
  },
  {
    id: "ask_4",
    caller: "ic-agent-2",
    target: "team-alpha",
    type: "blocker",
    status: "blocked",
    duration_label: "awaiting decision",
    intent:
      "Memory_fact promotion threshold disagreement: I want N=3 sessions with cosine ≥ 0.9 across ≥ 2 agents. Pattern is currently N=4 / 0.85 / 2. Which do we go with?",
    chain_depth: "1/4",
    source_session: "sess_c2d1",
    source_task_short_id: "T-1032",
  },
];

export interface GraphNode {
  id: string;
  label: string;
  hier_label: string;
  hier: "ic" | "team" | "org";
  cx: number;
  cy: number;
  r: number;
  state: "active" | "blocked" | "idle";
}

export interface GraphEdge {
  from: string;
  to: string;
  d: string;
  state: "live" | "blocker" | "completed";
  label?: { text: string; x: number; y: number };
}

export const fixtureGraph: { nodes: GraphNode[]; edges: GraphEdge[] } = {
  nodes: [
    { id: "root-org", label: "root-org", hier_label: "org", hier: "org", cx: 160, cy: 80, r: 22, state: "idle" },
    { id: "team-alpha", label: "team-alpha", hier_label: "team", hier: "team", cx: 105, cy: 200, r: 20, state: "active" },
    { id: "team-data", label: "team-data", hier_label: "team", hier: "team", cx: 240, cy: 200, r: 20, state: "idle" },
    { id: "ic-1", label: "ic-1", hier_label: "auth", hier: "ic", cx: 60, cy: 380, r: 18, state: "active" },
    { id: "ic-2", label: "ic-2", hier_label: "blocked", hier: "ic", cx: 140, cy: 380, r: 18, state: "blocked" },
    { id: "ic-3", label: "ic-3", hier_label: "infra", hier: "ic", cx: 220, cy: 380, r: 18, state: "active" },
    { id: "db", label: "db", hier_label: "data", hier: "ic", cx: 270, cy: 380, r: 18, state: "idle" },
  ],
  edges: [
    {
      from: "ic-1",
      to: "db",
      d: "M 80 380 Q 100 280, 240 380",
      state: "live",
      label: { text: "ask · 4s", x: 138, y: 290 },
    },
    {
      from: "ic-3",
      to: "team-alpha",
      d: "M 200 380 Q 180 280, 120 200",
      state: "live",
      label: { text: "negotiate", x: 146, y: 280 },
    },
    {
      from: "ic-2",
      to: "team-alpha",
      d: "M 140 380 Q 130 290, 120 200",
      state: "blocker",
      label: { text: "blocker", x: 60, y: 290 },
    },
    { from: "ic-1", to: "db", d: "M 80 380 Q 160 410, 240 380", state: "completed" },
    { from: "ic-2", to: "ic-3", d: "M 140 360 L 200 360", state: "completed" },
    { from: "team-alpha", to: "ic-1", d: "M 105 220 L 80 360", state: "completed" },
    { from: "db", to: "root-org", d: "M 240 365 Q 200 220, 160 100", state: "completed" },
  ],
};

export const fixtureMeshSummary = {
  asks_24h: 23,
  in_flight: 2,
  edge_count: 23,
};
