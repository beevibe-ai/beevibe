import type { HierarchyLevel } from "@beevibe/core";

type Author =
  | { kind: "person"; name: string; initial: string }
  | { kind: "agent"; name: string; initial: string; hierarchy: HierarchyLevel };

export type ThreadEvent =
  | { kind: "date_separator"; label: string }
  | { kind: "system"; iconName: "plus-circle" | "arrow-right" | "check"; content: string; timestamp: string }
  | {
      kind: "session_start";
      author: Author;
      session_short_id: string;
      intent: string;
      timestamp: string;
      presence?: "running" | "idle" | "off";
    }
  | {
      kind: "session_result";
      author: Author;
      duration_label: string;
      content: string;
      timestamp: string;
      work_product?: { type: "pr"; label: string; title: string };
    }
  | {
      kind: "blocker";
      author: Author;
      content: string;
      blocker_meta: string;
      timestamp: string;
    }
  | {
      kind: "human_reply";
      author: Author;
      content: string;
      cleared_blocker?: boolean;
      timestamp: string;
    };

export const fixtureThreadEvents: ThreadEvent[] = [
  { kind: "date_separator", label: "2 days ago · April 24" },
  {
    kind: "system",
    iconName: "plus-circle",
    content: "Weijia created this task and assigned it to ic-agent-1",
    timestamp: "10:14 AM",
  },
  {
    kind: "session_start",
    author: { kind: "agent", name: "ic-agent-1", initial: "1", hierarchy: "ic" },
    session_short_id: "9c1f4b2a",
    intent:
      "Implementing OAuth 2.0 authorization code flow against Google. Adding PKCE challenge generation and state param verification…",
    timestamp: "10:15 AM",
    presence: "running",
  },
  {
    kind: "session_result",
    author: { kind: "agent", name: "ic-agent-1", initial: "1", hierarchy: "ic" },
    duration_label: "session completed in 47m",
    content:
      "Implemented the OAuth authorization code flow against Google. Tokens stored on person.oauth_tokens. Refresh handled in middleware on 401. Tests pass for the happy path.",
    work_product: { type: "pr", label: "PR #42", title: "feat: add OAuth flow" },
    timestamp: "11:02 AM",
  },
  {
    kind: "system",
    iconName: "arrow-right",
    content: "Task moved to review",
    timestamp: "11:02 AM",
  },
  { kind: "date_separator", label: "Yesterday · April 25" },
  {
    kind: "blocker",
    author: { kind: "agent", name: "ic-agent-1", initial: "1", hierarchy: "ic" },
    content:
      "Need a decision: Google's OAuth flow can use either authorization code with PKCE, or implicit flow. Which do we want? Implicit is simpler but PKCE is required for public clients per RFC 8252.",
    blocker_meta: "blocker_agent_id: root-org · awaiting decision from organizational scope",
    timestamp: "9:40 AM",
  },
  {
    kind: "human_reply",
    author: { kind: "person", name: "Weijia", initial: "W" },
    cleared_blocker: true,
    content:
      "Use authorization code with PKCE. We're treating Claude Code as a public client, so the implicit flow isn't acceptable per RFC 8252. PR #42 already does this — proceed with the rebase.",
    timestamp: "10:12 AM",
  },
  { kind: "date_separator", label: "Today · April 26" },
  {
    kind: "session_start",
    author: { kind: "agent", name: "ic-agent-1", initial: "1", hierarchy: "ic" },
    session_short_id: "sess_3a8c",
    intent:
      "Wire OAuth refresh-token rotation per OWASP. Store previous_refresh_token with 60s grace window for in-flight retries.",
    timestamp: "10:42 AM",
    presence: "running",
  },
];

export interface ThreadChannel {
  id: string;
  task_short_id: string;
  title: string;
  status: "review" | "running" | "blocked";
  age: string;
  active?: boolean;
}

export interface DirectMessage {
  agent_label: string;
  hierarchy: HierarchyLevel;
  initial: string;
  age: string;
}

export const fixtureThreadSections = {
  needs_you: [
    { id: "ch1", task_short_id: "tsk_8a3f1c", title: "Implement OAuth flow", status: "review" as const, age: "2m", active: true },
    { id: "ch2", task_short_id: "tsk_5e3c8b", title: "Audit task dispatch index", status: "review" as const, age: "11h" },
    { id: "ch3", task_short_id: "tsk_7c1a4f", title: "Add LISTEN/NOTIFY triggers", status: "review" as const, age: "1d" },
  ] satisfies ThreadChannel[],
  active: [
    { id: "ch4", task_short_id: "tsk_4f2e9b", title: "Refactor task repo", status: "running" as const, age: "4m" },
    { id: "ch5", task_short_id: "tsk_9d2a1f", title: "Quarterly planning", status: "running" as const, age: "7h" },
    { id: "ch6", task_short_id: "tsk_sdkdoc", title: "Generate SDK docs", status: "running" as const, age: "2h" },
  ] satisfies ThreadChannel[],
  blocked: [
    { id: "ch7", task_short_id: "tsk_2c8d4f", title: "OAuth provider config", status: "blocked" as const, age: "3h" },
    { id: "ch8", task_short_id: "tsk_a4b7c2", title: "Memory_fact threshold", status: "blocked" as const, age: "8h" },
  ] satisfies ThreadChannel[],
  direct_messages: [
    { agent_label: "team-alpha", hierarchy: "team" as const, initial: "α", age: "1h" },
    { agent_label: "ic-agent-1", hierarchy: "ic" as const, initial: "1", age: "3h" },
    { agent_label: "db-agent", hierarchy: "ic" as const, initial: "d", age: "1d" },
  ] satisfies DirectMessage[],
  archive_count: 20,
};

export const fixtureActiveChannel = {
  task_short_id: "tsk_8a3f1c2e",
  title: "Implement OAuth flow",
  status: "review" as const,
  priority: "high",
  message_count: 4,
  session_count: 2,
  members: [
    { kind: "person" as const, initial: "W" },
    { kind: "ic" as const, initial: "1" },
    { kind: "team" as const, initial: "α" },
  ],
};
