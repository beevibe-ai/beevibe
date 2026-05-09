/**
 * Audit-log repository for `create_subordinate_agent` invocations
 * (Phase 9). One row per spawn — used for the per-parent daily cap
 * and for the agents-page audit panel.
 */

export interface AgentProvisionEvent {
  id: string;
  parent_agent_id: string;
  child_agent_id: string;
  owner_person_id: string;
  child_name: string;
  persona: string;
  domain: string;
  created_at: Date;
}

export type NewAgentProvisionEvent = Omit<AgentProvisionEvent, "created_at"> & {
  created_at?: Date;
};

export interface AgentProvisionEventRepository {
  create(input: NewAgentProvisionEvent): Promise<AgentProvisionEvent>;
  /** Count of events for a parent agent in the last `windowSeconds` seconds. Backs the daily cap. */
  countByParentSince(parentAgentId: string, windowSeconds: number): Promise<number>;
  listByParent(parentAgentId: string, limit?: number): Promise<AgentProvisionEvent[]>;
}
