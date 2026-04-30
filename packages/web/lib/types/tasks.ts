import type { Task } from "@beevibe/core";
import type { RichText } from "@/components/rich-text";

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
