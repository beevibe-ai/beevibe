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

export interface AgentMetrics {
  sessions: number;
  sessions_change: number;
  facts: number;
  merges: number;
  promoted: number;
}
