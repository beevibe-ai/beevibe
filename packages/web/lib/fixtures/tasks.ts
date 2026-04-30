import type { Task } from "@beevibe/core";
import type { RichText } from "@/components/rich-text";

const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000);
const hoursAgo = (h: number) => new Date(now - h * 3_600_000);
const daysAgo = (d: number) => new Date(now - d * 86_400_000);

export interface TaskListItem extends Omit<Task, "description" | "result_summary"> {
  assignee_hierarchy?: "ic" | "team" | "org";
  assignee_label?: string;
  creator_label?: string;
  description?: RichText[];
  result_summary?: RichText;
  session_count?: number;
  work_product_count?: number;
  latest_session?: {
    short_id: string;
    status: "running" | "succeeded" | "failed" | "cancelled";
    elapsed: string;
    agent_label: string;
  };
}

export function findTaskById(id: string): TaskListItem | undefined {
  const exact = fixtureTasks.find((t) => t.id === id);
  if (exact) return exact;
  return fixtureTasks[0];
}

export const fixtureTasks: TaskListItem[] = [
  {
    id: "tsk_8a3f1c00000000000000000000",
    title: "Implement OAuth flow",
    status: "review",
    priority: "high",
    creator_id: "per_weijia",
    creator_type: "person",
    creator_label: "Weijia",
    assignee_id: "agt_ic1",
    assignee_label: "ic-agent-1",
    assignee_hierarchy: "ic",
    description: [
      [
        "Add an OAuth 2.0 authorization code flow to the API so external clients can authenticate as a person without sharing their ",
        { mono: "bv_u_*" },
        " API key.",
      ],
      [
        "Provider: Google. Tokens stored in ",
        { mono: "person.oauth_tokens" },
        " (JSONB). PKCE required.",
      ],
    ],
    result_summary: [
      "Implemented the authorization code + PKCE flow against Google. Tokens stored on ",
      { mono: "person.oauth_tokens" },
      ". Refresh handled in middleware on 401. Added integration tests covering success, denied-consent, expired-state, and refresh paths.",
    ],
    session_count: 3,
    work_product_count: 1,
    latest_session: {
      short_id: "9c1f4b2a",
      status: "running",
      elapsed: "4m elapsed",
      agent_label: "ic-agent-1",
    },
    created_at: daysAgo(2),
    updated_at: minutesAgo(2),
  },
  {
    id: "tsk_5e3c8b00000000000000000000",
    title: "Audit task dispatch index for hot-row contention",
    status: "review",
    priority: "medium",
    creator_id: "per_weijia",
    creator_type: "person",
    creator_label: "Weijia",
    assignee_id: "agt_db",
    assignee_label: "db-agent",
    assignee_hierarchy: "ic",
    created_at: daysAgo(2),
    updated_at: hoursAgo(11),
  },
  {
    id: "tsk_7c1a4f00000000000000000000",
    title: "Add LISTEN/NOTIFY triggers for SSE",
    status: "review",
    priority: "medium",
    creator_id: "per_weijia",
    creator_type: "person",
    creator_label: "Weijia",
    assignee_id: "agt_db",
    assignee_label: "db-agent",
    assignee_hierarchy: "ic",
    created_at: daysAgo(2),
    updated_at: daysAgo(1),
  },
  {
    id: "tsk_2c8d4f00000000000000000000",
    title: "Add OAuth provider configuration UI",
    status: "blocked",
    priority: "low",
    creator_id: "agt_team_alpha",
    creator_type: "agent",
    creator_label: "team-alpha",
    assignee_id: "agt_team_alpha",
    assignee_label: "team-alpha",
    assignee_hierarchy: "team",
    blocker_agent_id: "agt_org",
    blocker_reason: "waiting on org-agent decision",
    created_at: daysAgo(1),
    updated_at: hoursAgo(3),
  },
  {
    id: "tsk_a4b7c200000000000000000000",
    title: "Wire memory_fact promotion threshold",
    status: "blocked",
    priority: "medium",
    creator_id: "per_weijia",
    creator_type: "person",
    creator_label: "Weijia",
    assignee_id: "agt_ic2",
    assignee_label: "ic-agent-2",
    assignee_hierarchy: "ic",
    created_at: daysAgo(1),
    updated_at: hoursAgo(8),
  },
  {
    id: "tsk_4f2e9b00000000000000000000",
    title: "Refactor task repo to use repository pattern",
    status: "in_progress",
    priority: "medium",
    creator_id: "per_weijia",
    creator_type: "person",
    creator_label: "Weijia",
    assignee_id: "agt_ic3",
    assignee_label: "ic-agent-3",
    assignee_hierarchy: "ic",
    created_at: hoursAgo(12),
    updated_at: minutesAgo(4),
  },
  {
    id: "tsk_1c8d4f00000000000000000000",
    title: "Migrate logging to pino across services",
    status: "revision",
    priority: "medium",
    creator_id: "per_weijia",
    creator_type: "person",
    creator_label: "Weijia",
    assignee_id: "agt_ic2",
    assignee_label: "ic-agent-2",
    assignee_hierarchy: "ic",
    created_at: daysAgo(1),
    updated_at: minutesAgo(30),
  },
  {
    id: "tsk_9d2a1f00000000000000000000",
    title: "Quarterly planning doc for Q2",
    status: "in_progress",
    priority: "high",
    creator_id: "agt_team_alpha",
    creator_type: "agent",
    creator_label: "team-alpha",
    assignee_id: "agt_team_alpha",
    assignee_label: "team-alpha",
    assignee_hierarchy: "team",
    created_at: daysAgo(1),
    updated_at: hoursAgo(7),
  },
  {
    id: "tsk_6b3a9c00000000000000000000",
    title: "Update changelog with M5 release notes",
    status: "assigned",
    priority: "low",
    creator_id: "per_weijia",
    creator_type: "person",
    creator_label: "Weijia",
    assignee_id: "agt_ic1",
    assignee_label: "ic-agent-1",
    assignee_hierarchy: "ic",
    created_at: hoursAgo(6),
    updated_at: hoursAgo(5),
  },
  {
    id: "tsk_8e4d2a00000000000000000000",
    title: "Draft RFC for OAuth scopes",
    status: "assigned",
    priority: "medium",
    creator_id: "per_weijia",
    creator_type: "person",
    creator_label: "Weijia",
    assignee_id: "agt_team_alpha",
    assignee_label: "team-alpha",
    assignee_hierarchy: "team",
    created_at: hoursAgo(7),
    updated_at: hoursAgo(6),
  },
  {
    id: "tsk_3f7e1d00000000000000000000",
    title: "Audit npm dependencies for security advisories",
    status: "pending",
    priority: "medium",
    creator_id: "per_weijia",
    creator_type: "person",
    creator_label: "Weijia",
    created_at: daysAgo(2),
    updated_at: daysAgo(2),
  },
];

export const fixtureCounts = {
  active: 27,
  archive: 20,
  all: 47,
  mineToReview: 7,
};
