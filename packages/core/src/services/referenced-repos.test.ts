import { describe, expect, it, vi } from "vitest";
import type { Session, SessionEvent } from "../domain/session.js";
import type { WorkProduct, WorkProductListItem } from "../domain/work-product.js";
import type { LearnedSkill } from "../domain/repo-run.js";
import { getReferencedRepos, type ReferencedReposDeps } from "./referenced-repos.js";

const NOW = new Date("2026-05-19T00:00:00Z");

function makeSession(id: string, taskId: string): Session {
  return {
    id,
    agent_id: "agent_x",
    task_id: taskId,
    type: "task",
    status: "succeeded",
    intent: "audit",
    created_at: NOW,
  };
}

function makeEvent(sessionId: string, content: string, kind: SessionEvent["kind"] = "tool_call"): SessionEvent {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    session_id: sessionId,
    kind,
    content,
    created_at: NOW,
  };
}

function makeProduct(taskId: string, body?: string, summary?: string): { item: WorkProductListItem; full: WorkProduct } {
  const id = `wp_${Math.random().toString(36).slice(2, 10)}`;
  const full: WorkProduct = {
    id,
    task_id: taskId,
    agent_id: "agent_x",
    type: "report",
    title: "Audit",
    summary,
    body,
    created_at: NOW,
    updated_at: NOW,
  };
  const item: WorkProductListItem = {
    ...full,
    body_bytes: body ? Buffer.byteLength(body, "utf8") : 0,
  };
  delete (item as Partial<WorkProduct>).body;
  return { item, full };
}

function buildDeps(opts: {
  sessions: Session[];
  events: Record<string, SessionEvent[]>;
  products: Array<{ item: WorkProductListItem; full: WorkProduct }>;
  learnedSkills?: LearnedSkill[];
}): ReferencedReposDeps {
  const productById = new Map(opts.products.map((p) => [p.full.id, p.full]));
  return {
    sessionRepo: {
      listForTask: vi.fn(async () => opts.sessions),
    } as unknown as ReferencedReposDeps["sessionRepo"],
    sessionEventRepo: {
      listBySession: vi.fn(async (id: string) => opts.events[id] ?? []),
    } as unknown as ReferencedReposDeps["sessionEventRepo"],
    workProductRepo: {
      listByTask: vi.fn(async () => opts.products.map((p) => p.item)),
      findById: vi.fn(async (id: string) => productById.get(id)),
    } as unknown as ReferencedReposDeps["workProductRepo"],
    learnedSkillRepo: {
      listByOwner: vi.fn(async () => opts.learnedSkills ?? []),
    } as unknown as ReferencedReposDeps["learnedSkillRepo"],
  };
}

describe("getReferencedRepos", () => {
  it("returns empty when no sessions and no products", async () => {
    const deps = buildDeps({ sessions: [], events: {}, products: [] });
    const out = await getReferencedRepos("t_1", "person_a", deps);
    expect(out).toEqual([]);
  });

  it("extracts repo URLs from tool_call event content", async () => {
    const session = makeSession("s_1", "t_1");
    const deps = buildDeps({
      sessions: [session],
      events: {
        s_1: [makeEvent("s_1", '{"url":"https://github.com/karpathy/llm.c"}')],
      },
      products: [],
    });
    const out = await getReferencedRepos("t_1", "person_a", deps);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ owner: "karpathy", name: "llm.c", url: "https://github.com/karpathy/llm.c", occurrences: 1, already_saved: false });
  });

  it("collapses subpaths to repo root and dedupes occurrences", async () => {
    const session = makeSession("s_1", "t_1");
    const deps = buildDeps({
      sessions: [session],
      events: {
        s_1: [
          makeEvent("s_1", "fetched https://github.com/karpathy/llm.c/blob/master/train_gpt2.py"),
          makeEvent("s_1", "also https://github.com/karpathy/llm.c", "tool_result"),
        ],
      },
      products: [],
    });
    const out = await getReferencedRepos("t_1", "person_a", deps);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://github.com/karpathy/llm.c");
    expect(out[0].occurrences).toBe(2);
  });

  it("strips .git suffix", async () => {
    const session = makeSession("s_1", "t_1");
    const deps = buildDeps({
      sessions: [session],
      events: {
        s_1: [makeEvent("s_1", "git clone https://github.com/foo/bar.git")],
      },
      products: [],
    });
    const out = await getReferencedRepos("t_1", "person_a", deps);
    expect(out[0]).toMatchObject({ owner: "foo", name: "bar", url: "https://github.com/foo/bar" });
  });

  it("filters non-repo owner paths (orgs, settings, marketplace)", async () => {
    const session = makeSession("s_1", "t_1");
    const deps = buildDeps({
      sessions: [session],
      events: {
        s_1: [
          makeEvent("s_1", "see https://github.com/orgs/foo/teams and https://github.com/settings/profile"),
          makeEvent("s_1", "but also https://github.com/karpathy/nanoGPT"),
        ],
      },
      products: [],
    });
    const out = await getReferencedRepos("t_1", "person_a", deps);
    expect(out).toHaveLength(1);
    expect(out[0].owner).toBe("karpathy");
  });

  it("scans work product summary and body", async () => {
    const session = makeSession("s_1", "t_1");
    const prod = makeProduct(
      "t_1",
      "Verdict: adopt https://github.com/foo/audited-repo with caveats.",
      "Audit of https://github.com/foo/audited-repo complete.",
    );
    const deps = buildDeps({
      sessions: [session],
      events: { s_1: [] },
      products: [prod],
    });
    const out = await getReferencedRepos("t_1", "person_a", deps);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://github.com/foo/audited-repo");
    expect(out[0].occurrences).toBe(2);
  });

  it("marks already_saved when caller owns a learned_skill for that URL", async () => {
    const session = makeSession("s_1", "t_1");
    const deps = buildDeps({
      sessions: [session],
      events: { s_1: [makeEvent("s_1", "https://github.com/foo/already-have")] },
      products: [],
      learnedSkills: [
        {
          id: "ls_1",
          name: "already-have",
          goal_pattern: "do thing",
          repo_url: "https://github.com/foo/already-have",
          repo_ref: "main",
          install_steps: "",
          invocation: "",
          owner_id: "person_a",
          created_at: NOW,
          updated_at: NOW,
        } as LearnedSkill,
      ],
    });
    const out = await getReferencedRepos("t_1", "person_a", deps);
    expect(out[0].already_saved).toBe(true);
  });

  it("sorts by occurrences descending", async () => {
    const session = makeSession("s_1", "t_1");
    const deps = buildDeps({
      sessions: [session],
      events: {
        s_1: [
          makeEvent("s_1", "https://github.com/a/one https://github.com/a/one"),
          makeEvent("s_1", "https://github.com/b/two"),
          makeEvent("s_1", "https://github.com/a/one"),
        ],
      },
      products: [],
    });
    const out = await getReferencedRepos("t_1", "person_a", deps);
    expect(out.map((r) => r.url)).toEqual([
      "https://github.com/a/one",
      "https://github.com/b/two",
    ]);
  });
});
