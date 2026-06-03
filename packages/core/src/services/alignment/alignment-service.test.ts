import { describe, expect, it, vi } from "vitest";
import { AlignmentService, TeamAgentRequiredError } from "./alignment-service.js";
import type { Agent } from "../../domain/agent.js";
import type { CoreMemoryBlock } from "../../domain/core-memory.js";
import type {
  AlignmentMeeting,
  AlignmentDigest,
  AlignmentActionItem,
} from "../../domain/alignment.js";

function agent(id: string, level: Agent["hierarchy_level"]): Agent {
  return {
    id,
    name: id,
    owner_id: "person_1",
    parent_agent_id: level === "ic" ? "team_1" : null,
    hierarchy_level: level,
    runtime_config: { type: "claude" },
    preferred_runtime_id: null,
    api_key: "k",
    review_policy: "auto",
    max_task_sessions: 1,
    max_mesh_sessions: 1,
    archived_at: null,
    capability_network_enabled: true,
  } as unknown as Agent;
}

function block(name: string, content: string): CoreMemoryBlock {
  return {
    id: `block_${name}`,
    agent_id: "ic_1",
    block_name: name,
    content,
    char_limit: 2000,
    description: "",
    is_system: true,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

/** In-memory fakes for the alignment repos. */
function makeRepos() {
  const meetings = new Map<string, AlignmentMeeting>();
  const digests: AlignmentDigest[] = [];
  const actions = new Map<string, AlignmentActionItem>();

  const meetingRepo = {
    create: vi.fn(async (input) => {
      const m: AlignmentMeeting = {
        id: input.id,
        team_agent_id: input.team_agent_id,
        owner_person_id: input.owner_person_id,
        status: input.status ?? "prepping",
        chat_session_id: null,
        notes: "",
        created_at: new Date(0),
        updated_at: new Date(0),
        wrapped_at: null,
      };
      meetings.set(m.id, m);
      return m;
    }),
    findById: vi.fn(async (id: string) => meetings.get(id)),
    findByChatSession: vi.fn(async (sid: string) =>
      [...meetings.values()].find((m) => m.chat_session_id === sid),
    ),
    listByOwner: vi.fn(async () => [...meetings.values()]),
    update: vi.fn(async (id: string, patch) => {
      const m = { ...meetings.get(id)!, ...patch };
      meetings.set(id, m);
      return m;
    }),
  };

  const digestRepo = {
    create: vi.fn(async (input) => {
      const d: AlignmentDigest = { ...input, created_at: new Date(0) };
      digests.push(d);
      return d;
    }),
    listByMeeting: vi.fn(async (mid: string) =>
      digests.filter((d) => d.meeting_id === mid),
    ),
  };

  const actionRepo = {
    create: vi.fn(async (input) => {
      const a: AlignmentActionItem = {
        id: input.id,
        meeting_id: input.meeting_id,
        agent_id: input.agent_id,
        kind: input.kind,
        title: input.title,
        rationale: input.rationale ?? "",
        target_ref: input.target_ref ?? null,
        status: input.status ?? "open",
        applied_session_id: null,
        applied_at: null,
        created_at: new Date(0),
        updated_at: new Date(0),
      };
      actions.set(a.id, a);
      return a;
    }),
    findById: vi.fn(async (id: string) => actions.get(id)),
    listByMeeting: vi.fn(async (mid: string) =>
      [...actions.values()].filter((a) => a.meeting_id === mid),
    ),
    update: vi.fn(async (id: string, patch) => {
      const a = { ...actions.get(id)!, ...patch };
      actions.set(id, a);
      return a;
    }),
  };

  return { meetingRepo, digestRepo, actionRepo, meetings, actions };
}

describe("AlignmentService", () => {
  it("prepare distills one digest per subordinate via the local model", async () => {
    const { meetingRepo, digestRepo, actionRepo } = makeRepos();
    const digestLlm = {
      type: "ollama",
      complete: vi.fn(),
      completeStructured: vi.fn(async () => ({
        value: {
          believes: ["Agents share one memory pool"],
          knows: ["TypeScript"],
          working_on: [],
          rules: [],
        },
        usage: { input_tokens: 1, output_tokens: 1, model: "gemma3:4b" },
      })),
    };

    const svc = new AlignmentService({
      agentRepo: {
        findById: vi.fn(async () => agent("team_1", "team")),
        findSubordinates: vi.fn(async () => [agent("ic_1", "ic")]),
      } as never,
      coreMemoryRepo: {
        findByAgent: vi.fn(async () => [block("domain", "Memory is shared across agents")]),
      } as never,
      memoryFactRepo: { listByAgentScope: vi.fn(async () => []) } as never,
      embed: { type: "fake", embed: vi.fn(), embedBatch: vi.fn() } as never,
      coreMemory: {} as never,
      factStore: {} as never,
      meetingRepo: meetingRepo as never,
      digestRepo: digestRepo as never,
      actionRepo: actionRepo as never,
      digestLlm: digestLlm as never,
    });

    const { meeting, digests } = await svc.prepare("team_1", "person_1");

    expect(meeting.status).toBe("active");
    expect(digests).toHaveLength(1);
    expect(digests[0]!.summary.believes).toContain("Agents share one memory pool");
    expect(digests[0]!.model).toBe("gemma3:4b");
    expect(digestLlm.completeStructured).toHaveBeenCalledOnce();
  });

  it("rejects an IC agent — no specialists to align", async () => {
    const { meetingRepo, digestRepo, actionRepo } = makeRepos();
    const svc = new AlignmentService({
      agentRepo: { findById: vi.fn(async () => agent("ic_1", "ic")) } as never,
      coreMemoryRepo: {} as never,
      memoryFactRepo: {} as never,
      embed: {} as never,
      coreMemory: {} as never,
      factStore: {} as never,
      meetingRepo: meetingRepo as never,
      digestRepo: digestRepo as never,
      actionRepo: actionRepo as never,
      digestLlm: {} as never,
    });
    await expect(svc.prepare("ic_1", "person_1")).rejects.toBeInstanceOf(
      TeamAgentRequiredError,
    );
  });

  it("applyActionItem writes a core_block correction back and marks it applied", async () => {
    const { meetingRepo, digestRepo, actionRepo } = makeRepos();
    const applyUpdate = vi.fn(async () => block("domain", "fixed"));
    const svc = new AlignmentService({
      agentRepo: {} as never,
      coreMemoryRepo: {} as never,
      memoryFactRepo: {} as never,
      embed: {} as never,
      coreMemory: { applyUpdate } as never,
      factStore: {} as never,
      meetingRepo: meetingRepo as never,
      digestRepo: digestRepo as never,
      actionRepo: actionRepo as never,
      digestLlm: {} as never,
    });

    const meeting = await meetingRepo.create({
      id: "amtg_1",
      team_agent_id: "team_1",
      owner_person_id: "person_1",
    });
    const item = await svc.createActionItem({
      meetingId: meeting.id,
      agentId: "ic_1",
      kind: "correct_memory",
      title: "Memory is self-contained per specialist",
      targetRef: {
        type: "core_block",
        block_name: "domain",
        operation: "replace",
        content: "Memory is self-contained per specialist",
        old_content: "Memory is shared across agents",
      },
    });

    const applied = await svc.applyActionItem(item.id, "sess_1");

    expect(applyUpdate).toHaveBeenCalledWith(
      "ic_1",
      "domain",
      "replace",
      "Memory is self-contained per specialist",
      "Memory is shared across agents",
    );
    expect(applied.status).toBe("applied");
    expect(applied.applied_session_id).toBe("sess_1");
  });
});
