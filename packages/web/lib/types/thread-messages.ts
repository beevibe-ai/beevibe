import type { HierarchyLevel } from "@beevibe/core";

export type Author =
  | { kind: "person"; name: string; initial: string }
  | { kind: "agent"; name: string; initial: string; hierarchy: HierarchyLevel };

export type ThreadEvent =
  | { kind: "date_separator"; label: string }
  | {
      kind: "system";
      iconName: "plus-circle" | "arrow-right" | "check";
      content: string;
      timestamp: string;
    }
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

export interface ActiveChannel {
  task_short_id: string;
  title: string;
  status: "review" | "running" | "blocked";
  priority: string;
  message_count: number;
  session_count: number;
  members: Array<
    | { kind: "person"; initial: string }
    | { kind: "ic" | "team" | "org"; initial: string }
  >;
}
