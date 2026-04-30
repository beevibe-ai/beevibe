import type { RichText } from "@/components/rich-text";

export interface MeshAsk {
  id: string;
  caller: string;
  target: string;
  intermediate?: string;
  arrow?: "right" | "up";
  type: "ask" | "negotiate" | "blocker";
  type_label?: string;
  status: "in_flight" | "succeeded" | "blocked";
  duration_label: string;
  intent: RichText;
  response?: { agent: string; content: RichText };
  chain_depth: string;
  chain_depth_color?: "review";
  source_session?: string;
  source_task_short_id?: string;
  source_task_age?: string;
  awaiting_label?: string;
  awaiting_task_short_id?: string;
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
    intent: [
      "Should the task-repo refactor preserve the existing index ",
      { mono: "idx_task_dispatch" },
      " verbatim, or rebuild as a partial index? Performance budget for dispatch query is 5ms p95.",
    ],
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
      content: [
        "Refresh blob fine in ",
        { mono: "refresh_token" },
        " table — but you need ",
        { mono: "FOR UPDATE SKIP LOCKED" },
        " on read for the rotation flow, or two concurrent rotations race the increment. Patch in ",
        { mono: "db_helpers.ts:142" },
        ".",
      ],
    },
    chain_depth: "1/4",
    source_session: "sess_3a8c",
    source_task_age: "18m ago",
  },
  {
    id: "ask_4",
    caller: "ic-agent-2",
    target: "ic-agent-3",
    type: "ask",
    status: "succeeded",
    duration_label: "4s",
    intent: "Did you already migrate the logger to pino, or am I about to step on your work?",
    response: {
      agent: "ic-agent-3",
      content: [
        "Task-repo logger only — ",
        { mono: "packages/core/src/adapters/postgres/task-repo.ts" },
        ". Yours is greenfield.",
      ],
    },
    chain_depth: "1/4",
    source_session: "sess_5d12",
    source_task_age: "47m ago",
  },
  {
    id: "ask_5",
    caller: "ic-agent-2",
    target: "team-alpha",
    arrow: "up",
    type: "blocker",
    type_label: "report_blocker",
    status: "blocked",
    duration_label: "blocker · 3h",
    intent:
      "OAuth provider config drifted between env vars and Auth0 dashboard. Need a human decision: roll forward with new redirect URI (breaks staging) or roll back the Auth0 change.",
    chain_depth: "1/4",
    awaiting_label: "awaiting",
    awaiting_task_short_id: "T-1014",
  },
  {
    id: "ask_6",
    caller: "team-alpha",
    target: "ic-agent-1",
    intermediate: "db-agent",
    type: "ask",
    status: "succeeded",
    duration_label: "24s",
    intent:
      "Is the OAuth refresh-token rotation production-safe? (ic-agent-1 sub-asked db-agent about lock semantics before answering.)",
    chain_depth: "2/4",
    chain_depth_color: "review",
    source_session: "sess_8c4a",
    source_task_age: "2h ago",
  },
  {
    id: "ask_7",
    caller: "db-agent",
    target: "root-org",
    type: "ask",
    status: "succeeded",
    duration_label: "6s",
    intent:
      "Should new migrations include explicit Down sections, or is auto-generated reverse acceptable?",
    response: {
      agent: "root-org",
      content:
        "Always explicit Down. Auto-generated reverses miss CHECK constraints and partial-index drops.",
    },
    chain_depth: "1/4",
    source_session: "sess_4f9a",
    source_task_age: "6h ago",
  },
];

export const fixtureMeshAsksOlderCount = 16;

export interface ChainBudgetRow {
  used_label: string;
  max_label: string;
  percent: number;
  color: "done" | "review" | "primary";
}

export const fixtureChainBudget: {
  avg_depth: ChainBudgetRow;
  max_depth: ChainBudgetRow;
  tokens: ChainBudgetRow;
} = {
  avg_depth: { used_label: "1.3", max_label: "4", percent: 32, color: "done" },
  max_depth: { used_label: "2", max_label: "4", percent: 50, color: "review" },
  tokens: { used_label: "8.2k", max_label: "50k", percent: 18, color: "primary" },
};

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
