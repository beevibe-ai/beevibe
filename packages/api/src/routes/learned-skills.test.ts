/**
 * /learned-skills REST surface — unit tests with vitest fakes (no DB).
 *
 * Create is the branchy one: it gates on slug shape, run status and
 * name collision, then writes SKILL.md to disk as a *non-fatal* side
 * effect. The tests point `repoRoot` at a tmpdir and read the file back,
 * which is what pins the two content shapes (agent artifact wrapped vs.
 * generated template) and the "a write failure still 201s" contract.
 *
 * Publish talks to the GitHub API, so the token path stubs `fetch` and
 * asserts the four-call sequence rather than reaching the network.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { json } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LearnedSkill,
  LearnedSkillRepository,
  RepoRun,
  RepoRunRepository,
  WorkProduct,
  WorkProductListItem,
  WorkProductRepository,
} from "@beevibe/core";
import { createLearnedSkillsRouter } from "./learned-skills.js";

const PERSON = "person_1";

// ── Fakes ────────────────────────────────────────────────────────────────

function fakeRun(overrides: Partial<RepoRun> = {}): RepoRun {
  return {
    id: "run_1",
    agent_id: "agent_a",
    goal: "add a linter",
    repo_url: "https://github.com/acme/tool",
    repo_ref: "abc123def456789",
    status: "succeeded",
    transcript: [],
    install_log: "pnpm install",
    invocation: "pnpm lint",
    started_at: new Date("2026-05-01"),
    ...overrides,
  };
}

function fakeSkill(overrides: Partial<LearnedSkill> = {}): LearnedSkill {
  return {
    id: "lskill_1",
    name: "acme-lint",
    goal_pattern: "lint a repo with acme",
    repo_url: "https://github.com/acme/tool",
    repo_ref: "abc123def456789",
    install_steps: "pnpm install",
    invocation: "pnpm lint",
    source_run_id: "run_1",
    owner_id: PERSON,
    created_at: new Date("2026-05-01"),
    updated_at: new Date("2026-05-01"),
    ...overrides,
  };
}

function makeSkillRepo(): LearnedSkillRepository {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByOwnerAndName: vi.fn(),
    listByOwner: vi.fn(),
    searchByGoal: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function makeRunRepo(): RepoRunRepository {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findBySessionId: vi.fn(),
    listByAgent: vi.fn(),
    listRecent: vi.fn(),
    update: vi.fn(),
  };
}

function makeWorkProductRepo(): WorkProductRepository {
  return {
    findById: vi.fn(),
    listByTask: vi.fn(),
    listByAgent: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function stubAuth(source: "human" | "agent" | "none" = "human") {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (source === "human") {
      req.caller = {
        source: "human",
        agentId: "agent_a",
        hierarchyLevel: "team",
        personId: PERSON,
      };
    } else if (source === "agent") {
      req.caller = { source: "agent", agentId: "agent_a", hierarchyLevel: "ic" };
    }
    next();
  };
}

interface Deps {
  learnedSkillRepo: LearnedSkillRepository;
  repoRunRepo: RepoRunRepository;
  workProductRepo: WorkProductRepository;
}

function makeDeps(): Deps {
  return {
    learnedSkillRepo: makeSkillRepo(),
    repoRunRepo: makeRunRepo(),
    workProductRepo: makeWorkProductRepo(),
  };
}

let repoRoot: string;

function makeApp(deps: Deps, source: "human" | "agent" | "none" = "human", root = repoRoot) {
  const app = express();
  app.use(json());
  app.use(
    "/learned-skills",
    createLearnedSkillsRouter({ authMiddleware: stubAuth(source), ...deps, repoRoot: root }),
  );
  return app;
}

function skillMdPath(name: string) {
  return join(repoRoot, "skills", "learned", name, "SKILL.md");
}

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "beevibe-learned-skills-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.BEEVIBE_REGISTRY_TOKEN;
});

// ── GET /learned-skills ──────────────────────────────────────────────────

describe("GET /learned-skills", () => {
  it("lists the caller's own skills", async () => {
    const deps = makeDeps();
    vi.mocked(deps.learnedSkillRepo.listByOwner).mockResolvedValue([fakeSkill()]);

    const res = await request(makeApp(deps)).get("/learned-skills");

    expect(res.status).toBe(200);
    expect(res.body.skills).toHaveLength(1);
    expect(deps.learnedSkillRepo.listByOwner).toHaveBeenCalledWith(PERSON);
  });

  it("500s when the repo throws", async () => {
    const deps = makeDeps();
    vi.mocked(deps.learnedSkillRepo.listByOwner).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(deps)).get("/learned-skills");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("list_failed");
  });

  it("403s an agent caller", async () => {
    const deps = makeDeps();
    const res = await request(makeApp(deps, "agent")).get("/learned-skills");

    expect(res.status).toBe(403);
    expect(deps.learnedSkillRepo.listByOwner).not.toHaveBeenCalled();
  });
});

// ── POST /learned-skills ─────────────────────────────────────────────────

describe("POST /learned-skills — validation", () => {
  const valid = { name: "acme-lint", goal_pattern: "lint it", repo_run_id: "run_1" };

  it.each([
    ["name", { ...valid, name: undefined }],
    ["goal_pattern", { ...valid, goal_pattern: undefined }],
    ["repo_run_id", { ...valid, repo_run_id: undefined }],
  ])("400s when %s is missing", async (_field, body) => {
    const deps = makeDeps();
    const res = await request(makeApp(deps)).post("/learned-skills").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(deps.repoRunRepo.findById).not.toHaveBeenCalled();
  });

  it.each([
    ["uppercase", "Acme-Lint"],
    ["underscores", "acme_lint"],
    ["a single character", "a"],
    ["over 64 characters", "a".repeat(65)],
    ["a path separator", "acme/lint"],
    ["traversal", "../escape"],
  ])("400s on a name with %s", async (_label, name) => {
    const deps = makeDeps();
    const res = await request(makeApp(deps)).post("/learned-skills").send({ ...valid, name });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_name");
    expect(deps.repoRunRepo.findById).not.toHaveBeenCalled();
  });

  it("404s when the source run is unknown", async () => {
    const deps = makeDeps();
    vi.mocked(deps.repoRunRepo.findById).mockResolvedValue(undefined);

    const res = await request(makeApp(deps)).post("/learned-skills").send(valid);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("repo_run_not_found");
  });

  it.each(["running", "failed", "cancelled"] as const)(
    "409s when the source run is %s rather than succeeded",
    async (status) => {
      const deps = makeDeps();
      vi.mocked(deps.repoRunRepo.findById).mockResolvedValue(fakeRun({ status }));

      const res = await request(makeApp(deps)).post("/learned-skills").send(valid);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: "run_not_succeeded", current_status: status });
      expect(deps.learnedSkillRepo.create).not.toHaveBeenCalled();
    },
  );

  it("409s when the caller already has a skill with that name", async () => {
    const deps = makeDeps();
    vi.mocked(deps.repoRunRepo.findById).mockResolvedValue(fakeRun());
    vi.mocked(deps.learnedSkillRepo.findByOwnerAndName).mockResolvedValue(fakeSkill());

    const res = await request(makeApp(deps)).post("/learned-skills").send(valid);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("name_taken");
    expect(deps.learnedSkillRepo.findByOwnerAndName).toHaveBeenCalledWith(PERSON, "acme-lint");
    expect(deps.learnedSkillRepo.create).not.toHaveBeenCalled();
  });

  it("403s an agent caller", async () => {
    const deps = makeDeps();
    const res = await request(makeApp(deps, "agent")).post("/learned-skills").send(valid);

    expect(res.status).toBe(403);
    expect(deps.repoRunRepo.findById).not.toHaveBeenCalled();
  });
});

describe("POST /learned-skills — creation", () => {
  const valid = { name: "acme-lint", goal_pattern: "lint a repo with acme", repo_run_id: "run_1" };

  function wireCreate(deps: Deps, run = fakeRun()) {
    vi.mocked(deps.repoRunRepo.findById).mockResolvedValue(run);
    vi.mocked(deps.learnedSkillRepo.findByOwnerAndName).mockResolvedValue(undefined);
    vi.mocked(deps.learnedSkillRepo.create).mockImplementation(async (input) =>
      fakeSkill(input as Partial<LearnedSkill>),
    );
    vi.mocked(deps.workProductRepo.listByTask).mockResolvedValue([]);
    vi.mocked(deps.repoRunRepo.update).mockResolvedValue(run);
  }

  it("creates the row from the run and back-links the run", async () => {
    const deps = makeDeps();
    wireCreate(deps);

    const res = await request(makeApp(deps)).post("/learned-skills").send(valid);

    expect(res.status).toBe(201);
    expect(res.body.skill).toMatchObject({
      name: "acme-lint",
      goal_pattern: "lint a repo with acme",
      repo_url: "https://github.com/acme/tool",
      owner_id: PERSON,
      source_run_id: "run_1",
    });
    expect(deps.repoRunRepo.update).toHaveBeenCalledWith("run_1", {
      learned_skill_id: res.body.skill.id,
    });
  });

  it("defaults repo_ref, install_steps and invocation when the run lacks them", async () => {
    const deps = makeDeps();
    const bare = fakeRun();
    delete bare.repo_ref;
    delete bare.install_log;
    delete bare.invocation;
    wireCreate(deps, bare);

    const res = await request(makeApp(deps)).post("/learned-skills").send(valid);

    expect(res.status).toBe(201);
    const created = vi.mocked(deps.learnedSkillRepo.create).mock.calls[0]![0];
    expect(created.repo_ref).toBe("HEAD");
    expect(created.install_steps).toBe("(see run transcript)");
    expect(created.invocation).toBe("(see run transcript)");
  });

  it("writes a generated SKILL.md when no artifact is reachable", async () => {
    const deps = makeDeps();
    wireCreate(deps);

    await request(makeApp(deps)).post("/learned-skills").send(valid);

    const md = await readFile(skillMdPath("acme-lint"), "utf8");
    expect(md).toContain("name: acme-lint");
    expect(md).toContain("source_repo: https://github.com/acme/tool");
    // Title-cased from the slug.
    expect(md).toContain("# Acme Lint");
    expect(md).toContain("## Known install steps");
    expect(md).toContain("pnpm lint");
    // The generated template truncates the ref to 12 chars in the prose.
    expect(md).toContain("abc123def456");
  });

  it("inlines the agent's artifact body instead of the template when one exists", async () => {
    const deps = makeDeps();
    const run = fakeRun({ task_id: "task_9" });
    wireCreate(deps, run);
    vi.mocked(deps.workProductRepo.listByTask).mockResolvedValue([
      { id: "wp_1", type: "artifact" } as WorkProductListItem,
    ]);
    vi.mocked(deps.workProductRepo.findById).mockResolvedValue({
      id: "wp_1",
      type: "artifact",
      body: "# Real findings\n\nThe agent wrote this.",
    } as WorkProduct);

    await request(makeApp(deps)).post("/learned-skills").send(valid);

    const md = await readFile(skillMdPath("acme-lint"), "utf8");
    expect(md).toContain("# Real findings");
    expect(md).toContain("The agent wrote this.");
    expect(md).toContain("## Provenance");
    // The generated template's headings must NOT appear — the artifact
    // replaces the body wholesale rather than being appended to it.
    expect(md).not.toContain("## Known install steps");
  });

  it("prefers the artifact stamped with this run over the first artifact", async () => {
    const deps = makeDeps();
    wireCreate(deps, fakeRun({ task_id: "task_9" }));
    vi.mocked(deps.workProductRepo.listByTask).mockResolvedValue([
      { id: "wp_other", type: "artifact" } as WorkProductListItem,
      {
        id: "wp_ours",
        type: "artifact",
        metadata: { repo_run_id: "run_1" },
      } as unknown as WorkProductListItem,
    ]);
    vi.mocked(deps.workProductRepo.findById).mockResolvedValue({
      id: "wp_ours",
      type: "artifact",
      body: "# Ours",
    } as WorkProduct);

    await request(makeApp(deps)).post("/learned-skills").send(valid);

    expect(deps.workProductRepo.findById).toHaveBeenCalledWith("wp_ours");
  });

  it("indents a multi-line goal so the YAML frontmatter stays valid", async () => {
    const deps = makeDeps();
    wireCreate(deps, fakeRun({ task_id: "task_9" }));
    vi.mocked(deps.workProductRepo.listByTask).mockResolvedValue([
      { id: "wp_1", type: "artifact" } as WorkProductListItem,
    ]);
    vi.mocked(deps.workProductRepo.findById).mockResolvedValue({
      id: "wp_1",
      type: "artifact",
      body: "body",
    } as WorkProduct);

    await request(makeApp(deps))
      .post("/learned-skills")
      .send({ ...valid, goal_pattern: "line one\nline two" });

    const md = await readFile(skillMdPath("acme-lint"), "utf8");
    expect(md).toContain("description: >\n  line one\n  line two\n");
  });

  it("falls back to the template when the artifact lookup throws", async () => {
    const deps = makeDeps();
    wireCreate(deps, fakeRun({ task_id: "task_9" }));
    vi.mocked(deps.workProductRepo.listByTask).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(deps)).post("/learned-skills").send(valid);

    expect(res.status).toBe(201);
    const md = await readFile(skillMdPath("acme-lint"), "utf8");
    expect(md).toContain("## Known install steps");
  });

  it("still 201s when the SKILL.md write fails — the DB row is the source of truth", async () => {
    const deps = makeDeps();
    wireCreate(deps);
    // Point repoRoot at a regular file, so `mkdir -p <root>/skills/learned/...`
    // fails with ENOTDIR and the write path throws.
    const asFile = join(repoRoot, "not-a-dir");
    await writeFile(asFile, "i am a file", "utf8");

    const res = await request(makeApp(deps, "human", asFile))
      .post("/learned-skills")
      .send(valid);

    expect(res.status).toBe(201);
    expect(res.body.skill.name).toBe("acme-lint");
    // The row still gets back-linked — only the filesystem sync was lost.
    expect(deps.repoRunRepo.update).toHaveBeenCalled();
  });

  it("500s when the create itself throws", async () => {
    const deps = makeDeps();
    wireCreate(deps);
    vi.mocked(deps.learnedSkillRepo.create).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(deps)).post("/learned-skills").send(valid);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("create_failed");
  });
});

// ── DELETE /learned-skills/:id ───────────────────────────────────────────

describe("DELETE /learned-skills/:id", () => {
  it("deletes a skill the caller owns", async () => {
    const deps = makeDeps();
    vi.mocked(deps.learnedSkillRepo.findById).mockResolvedValue(fakeSkill());

    const res = await request(makeApp(deps)).delete("/learned-skills/lskill_1");

    expect(res.status).toBe(204);
    expect(deps.learnedSkillRepo.delete).toHaveBeenCalledWith("lskill_1");
  });

  it("404s an unknown skill", async () => {
    const deps = makeDeps();
    vi.mocked(deps.learnedSkillRepo.findById).mockResolvedValue(undefined);

    const res = await request(makeApp(deps)).delete("/learned-skills/lskill_x");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    expect(deps.learnedSkillRepo.delete).not.toHaveBeenCalled();
  });

  it("403s — and does not delete — somebody else's skill", async () => {
    const deps = makeDeps();
    vi.mocked(deps.learnedSkillRepo.findById).mockResolvedValue(
      fakeSkill({ owner_id: "person_other" }),
    );

    const res = await request(makeApp(deps)).delete("/learned-skills/lskill_1");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_owner");
    expect(deps.learnedSkillRepo.delete).not.toHaveBeenCalled();
  });

  it("500s when the delete throws", async () => {
    const deps = makeDeps();
    vi.mocked(deps.learnedSkillRepo.findById).mockResolvedValue(fakeSkill());
    vi.mocked(deps.learnedSkillRepo.delete).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(deps)).delete("/learned-skills/lskill_1");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("delete_failed");
  });

  it("403s an agent caller", async () => {
    const deps = makeDeps();
    const res = await request(makeApp(deps, "agent")).delete("/learned-skills/lskill_1");

    expect(res.status).toBe(403);
    expect(deps.learnedSkillRepo.findById).not.toHaveBeenCalled();
  });
});

// ── POST /learned-skills/:id/publish ─────────────────────────────────────

describe("POST /learned-skills/:id/publish", () => {
  it("returns manual-PR instructions plus the SKILL.md when no token is set", async () => {
    const deps = makeDeps();
    vi.mocked(deps.learnedSkillRepo.findById).mockResolvedValue(fakeSkill());

    const res = await request(makeApp(deps)).post("/learned-skills/lskill_1/publish");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      reason: "no_token",
      target_repo: "beevibe-ai/beevibe-capabilities",
      target_path: "skills/acme-lint/SKILL.md",
    });
    expect(res.body.skill_md).toContain("name: acme-lint");
    expect(deps.learnedSkillRepo.update).not.toHaveBeenCalled();
  });

  it("404s an unknown skill and 403s somebody else's", async () => {
    const deps = makeDeps();
    vi.mocked(deps.learnedSkillRepo.findById).mockResolvedValue(undefined);
    const missing = await request(makeApp(deps)).post("/learned-skills/lskill_x/publish");
    expect(missing.status).toBe(404);

    vi.mocked(deps.learnedSkillRepo.findById).mockResolvedValue(
      fakeSkill({ owner_id: "person_other" }),
    );
    const foreign = await request(makeApp(deps)).post("/learned-skills/lskill_1/publish");
    expect(foreign.status).toBe(403);
  });

  it("opens a PR through the GitHub API when a token is set", async () => {
    process.env.BEEVIBE_REGISTRY_TOKEN = "ghp_test";
    const deps = makeDeps();
    vi.mocked(deps.learnedSkillRepo.findById).mockResolvedValue(fakeSkill());
    vi.mocked(deps.learnedSkillRepo.update).mockResolvedValue(fakeSkill());

    const json200 = (payload: unknown) =>
      ({ ok: true, status: 200, json: async () => payload }) as Response;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json200({ default_branch: "main" }))
      .mockResolvedValueOnce(json200({ object: { sha: "basesha" } }))
      .mockResolvedValueOnce(json200({}))
      .mockResolvedValueOnce(json200({}))
      .mockResolvedValueOnce(json200({ html_url: "https://github.com/x/y/pull/7" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(makeApp(deps)).post("/learned-skills/lskill_1/publish");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, pr_url: "https://github.com/x/y/pull/7" });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toBe("https://api.github.com/repos/beevibe-ai/beevibe-capabilities");
    expect(urls[1]).toContain("/git/ref/heads/main");
    expect(urls[2]).toContain("/git/refs");
    expect(urls[3]).toContain("/contents/skills/acme-lint/SKILL.md");
    expect(urls[4]).toContain("/pulls");

    // The file body is sent base64-encoded and must round-trip to the md.
    const filePut = JSON.parse(String(fetchMock.mock.calls[3]![1].body)) as { content: string };
    expect(Buffer.from(filePut.content, "base64").toString("utf8")).toContain("name: acme-lint");

    const [id, patch] = vi.mocked(deps.learnedSkillRepo.update).mock.calls[0]!;
    expect(id).toBe("lskill_1");
    expect(patch).toMatchObject({
      published_to: "community",
      published_pr: "https://github.com/x/y/pull/7",
    });
    expect(patch.published_at).toBeInstanceOf(Date);
  });

  it("500s with the upstream status when a GitHub call fails", async () => {
    process.env.BEEVIBE_REGISTRY_TOKEN = "ghp_test";
    const deps = makeDeps();
    vi.mocked(deps.learnedSkillRepo.findById).mockResolvedValue(fakeSkill());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) } as Response),
    );

    const res = await request(makeApp(deps)).post("/learned-skills/lskill_1/publish");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("publish_failed");
    expect(res.body.message).toContain("403");
    // The skill must not be marked published when the PR never opened.
    expect(deps.learnedSkillRepo.update).not.toHaveBeenCalled();
  });

  it("403s an agent caller", async () => {
    const deps = makeDeps();
    const res = await request(makeApp(deps, "agent")).post("/learned-skills/lskill_1/publish");

    expect(res.status).toBe(403);
    expect(deps.learnedSkillRepo.findById).not.toHaveBeenCalled();
  });
});
