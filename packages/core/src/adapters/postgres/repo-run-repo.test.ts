/**
 * Capability-network adapters — integration tests against beevibe_test.
 *
 * These three repos back `use_repo`: the run log, the recipes captured
 * from successful runs, and the review verdicts that rank them. The
 * parts worth pinning against a real engine are the ones a fake pool
 * can't show — the `COALESCE`-based patch semantics (undefined and null
 * both mean "leave alone"), jsonb round-tripping of the transcript,
 * `websearch_to_tsquery` ranking, and the `ON CONFLICT` upsert that
 * keeps a re-review from stacking rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import {
  agentId,
  learnedSkillId,
  personId,
  repoRunId,
  sessionId,
  skillOutcomeId,
  taskId,
} from "../../domain/ids.js";
import type { RepoRunTranscriptEvent } from "../../domain/repo-run.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import type { Pool } from "./client.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";
import {
  PostgresLearnedSkillRepository,
  PostgresRepoRunRepository,
  PostgresSkillOutcomeRepository,
  newSkillOutcomeId,
} from "./repo-run-repo.js";
import { PostgresSessionRepository } from "./session-repo.js";
import { PostgresTaskRepository } from "./task-repo.js";

describe("capability-network postgres repositories", () => {
  let pool: Pool;
  let runs: PostgresRepoRunRepository;
  let skills: PostgresLearnedSkillRepository;
  let outcomes: PostgresSkillOutcomeRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let sessions: PostgresSessionRepository;
  let tasks: PostgresTaskRepository;

  let owner: string;
  let agent: string;

  beforeAll(() => {
    pool = createTestPool();
    runs = new PostgresRepoRunRepository(pool);
    skills = new PostgresLearnedSkillRepository(pool);
    outcomes = new PostgresSkillOutcomeRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
    sessions = new PostgresSessionRepository(pool);
    tasks = new PostgresTaskRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const p = await persons.create({ id: personId(), name: "Owner" });
    owner = p.id;
    const a = await agents.create({
      id: agentId(),
      name: "Runner",
      owner_id: owner,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    agent = a.id;
  });

  async function newRun(overrides: Record<string, unknown> = {}) {
    return runs.create({
      id: repoRunId(),
      agent_id: agent,
      goal: "extract tables from a PDF",
      repo_url: "https://github.com/acme/pdf-tools",
      ...overrides,
    });
  }

  async function newSkill(overrides: Record<string, unknown> = {}) {
    return skills.create({
      id: learnedSkillId(),
      name: "pdf-tables",
      goal_pattern: "extract tables from PDF documents",
      repo_url: "https://github.com/acme/pdf-tools",
      repo_ref: "main",
      install_steps: "pip install -e .",
      invocation: "python -m pdftools extract",
      owner_id: owner,
      ...overrides,
    });
  }

  // ── repo_run ───────────────────────────────────────────────────────────

  describe("PostgresRepoRunRepository", () => {
    it("defaults status to pending and the transcript to an empty array", async () => {
      const run = await newRun();

      expect(run.status).toBe("pending");
      expect(run.transcript).toEqual([]);
      expect(run.started_at).toBeInstanceOf(Date);
      // Absent columns come back as undefined, never null — the domain
      // type has no nullable fields.
      expect(run.session_id).toBeUndefined();
      expect(run.task_id).toBeUndefined();
      expect(run.repo_ref).toBeUndefined();
      expect(run.ended_at).toBeUndefined();
      expect(run.error).toBeUndefined();
      expect(run.learned_skill_id).toBeUndefined();
      expect(run.ranker_candidates).toBeUndefined();
    });

    it("round-trips every optional column and the jsonb transcript", async () => {
      const session = await sessions.create({
        id: sessionId(),
        agent_id: agent,
        type: "task",
        status: "running",
        intent: "run the repo",
      });
      const task = await tasks.create({
        id: taskId(),
        title: "T",
        priority: "medium",
        creator_id: owner,
        creator_type: "person",
      });
      const transcript: RepoRunTranscriptEvent[] = [
        { at: "2026-05-01T00:00:00.000Z", kind: "log", text: "cloned" },
        { at: "2026-05-01T00:00:01.000Z", kind: "tool_call", text: "pip install" },
      ];

      const run = await newRun({
        session_id: session.id,
        task_id: task.id,
        repo_ref: "v2.1.0",
        status: "running",
        transcript,
      });

      expect(run).toMatchObject({
        session_id: session.id,
        task_id: task.id,
        repo_ref: "v2.1.0",
        status: "running",
      });
      // jsonb survives the round trip as structured data, not a string.
      expect(await runs.findById(run.id)).toMatchObject({ transcript });
    });

    it("finds by id and by session id, and misses cleanly", async () => {
      const session = await sessions.create({
        id: sessionId(),
        agent_id: agent,
        type: "task",
        status: "running",
        intent: "x",
      });
      const run = await newRun({ session_id: session.id });

      expect((await runs.findById(run.id))?.id).toBe(run.id);
      expect((await runs.findBySessionId(session.id))?.id).toBe(run.id);
      expect(await runs.findById("repo_missing")).toBeUndefined();
      expect(await runs.findBySessionId("sess_missing")).toBeUndefined();
    });

    it("lists recent runs across every agent", async () => {
      const other = await agents.create({
        id: agentId(),
        name: "Other",
        owner_id: owner,
        hierarchy_level: "ic",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      });
      await newRun();
      await newRun({ agent_id: other.id });

      expect(await runs.listRecent()).toHaveLength(2);
      expect(await runs.listRecent({ limit: 1 })).toHaveLength(1);
    });

    it("patches only the fields supplied", async () => {
      const run = await newRun({ repo_ref: "main", status: "running" });
      const endedAt = new Date("2026-05-02T00:00:00Z");

      const updated = await runs.update(run.id, {
        status: "succeeded",
        install_log: "ok",
        invocation: "python -m pdftools",
        ended_at: endedAt,
        ranker_candidates: [{ skill: "pdf-tables", score: 0.9 }],
      });

      expect(updated).toMatchObject({
        status: "succeeded",
        install_log: "ok",
        invocation: "python -m pdftools",
        // Untouched by this patch.
        repo_ref: "main",
        goal: run.goal,
      });
      expect(updated.ended_at?.toISOString()).toBe(endedAt.toISOString());
      expect(updated.ranker_candidates).toEqual([{ skill: "pdf-tables", score: 0.9 }]);
    });

    it("treats an explicit null as no-change, not as a clear", async () => {
      // Documented MVP behavior: `normalizeNullable` collapses null onto
      // the COALESCE fallback so a partial patch can't wipe a column.
      const run = await newRun({ repo_ref: "v1" });
      await runs.update(run.id, { install_log: "first", error: "boom" });

      const updated = await runs.update(run.id, {
        install_log: null,
        error: null,
        repo_ref: null,
        learned_skill_id: null,
        ended_at: null,
      });

      expect(updated).toMatchObject({
        install_log: "first",
        error: "boom",
        repo_ref: "v1",
      });
      expect(updated.ended_at).toBeUndefined();
    });

    it("replaces the transcript wholesale, and an empty patch is a no-op", async () => {
      const run = await newRun({
        transcript: [{ at: "2026-05-01T00:00:00.000Z", kind: "log", text: "one" }],
      });

      const replaced = await runs.update(run.id, {
        transcript: [{ at: "2026-05-01T00:00:02.000Z", kind: "agent", text: "two" }],
      });
      expect(replaced.transcript).toEqual([
        { at: "2026-05-01T00:00:02.000Z", kind: "agent", text: "two" },
      ]);

      const untouched = await runs.update(run.id, {});
      expect(untouched.transcript).toEqual(replaced.transcript);
      expect(untouched.status).toBe("pending");
    });

    it("links a captured skill back onto the run", async () => {
      const run = await newRun();
      const skill = await newSkill({ source_run_id: run.id });

      const updated = await runs.update(run.id, { learned_skill_id: skill.id });

      expect(updated.learned_skill_id).toBe(skill.id);
    });

    it("throws on updating a run that doesn't exist", async () => {
      await expect(runs.update("repo_missing", { status: "failed" })).rejects.toThrow(
        "repo_run repo_missing not found",
      );
    });
  });

  // ── learned_skill ──────────────────────────────────────────────────────

  describe("PostgresLearnedSkillRepository", () => {
    it("creates a skill with publication columns unset", async () => {
      const skill = await newSkill();

      expect(skill).toMatchObject({
        name: "pdf-tables",
        repo_ref: "main",
        owner_id: owner,
      });
      expect(skill.source_run_id).toBeUndefined();
      expect(skill.published_to).toBeUndefined();
      expect(skill.published_pr).toBeUndefined();
      expect(skill.published_at).toBeUndefined();
    });

    it("records the run it was captured from", async () => {
      const run = await newRun();
      const skill = await newSkill({ source_run_id: run.id });

      expect((await skills.findById(skill.id))?.source_run_id).toBe(run.id);
    });

    it("finds by id and by (owner, name), and misses cleanly", async () => {
      const skill = await newSkill();
      const stranger = await persons.create({ id: personId(), name: "Stranger" });

      expect((await skills.findByOwnerAndName(owner, "pdf-tables"))?.id).toBe(skill.id);
      // Names are unique per owner, so the same name under another owner
      // must not resolve — that would be a cross-tenant read.
      expect(await skills.findByOwnerAndName(stranger.id, "pdf-tables")).toBeUndefined();
      expect(await skills.findByOwnerAndName(owner, "nope")).toBeUndefined();
      expect(await skills.findById("skill_missing")).toBeUndefined();
    });

    it("lists an owner's skills newest-first", async () => {
      const stranger = await persons.create({ id: personId(), name: "Stranger" });
      const older = await newSkill({ name: "older" });
      const newer = await newSkill({ name: "newer" });
      await newSkill({ name: "theirs", owner_id: stranger.id });
      await pool.query(`UPDATE learned_skill SET created_at = $2 WHERE id = $1`, [
        older.id,
        new Date("2026-01-01T00:00:00Z"),
      ]);
      await pool.query(`UPDATE learned_skill SET created_at = $2 WHERE id = $1`, [
        newer.id,
        new Date("2026-02-01T00:00:00Z"),
      ]);

      expect((await skills.listByOwner(owner)).map((s) => s.name)).toEqual([
        "newer",
        "older",
      ]);
      expect((await skills.listByOwner(stranger.id)).map((s) => s.name)).toEqual(["theirs"]);
    });

    it("matches a bare phrase through websearch_to_tsquery", async () => {
      const pdf = await newSkill();
      await newSkill({
        name: "csv-merge",
        goal_pattern: "merge CSV files into one workbook",
      });

      // No tsquery operators — the caller passes the user's words verbatim.
      const hits = await skills.searchByGoal(owner, "extract tables from PDF");

      expect(hits.map((s) => s.id)).toEqual([pdf.id]);
      // Stemming: "documents" in the pattern matches "document".
      expect((await skills.searchByGoal(owner, "PDF document")).map((s) => s.id)).toEqual([
        pdf.id,
      ]);
      expect(await skills.searchByGoal(owner, "kubernetes")).toEqual([]);
    });

    it("scopes the search to the owner and honours the limit", async () => {
      const stranger = await persons.create({ id: personId(), name: "Stranger" });
      await newSkill();
      await newSkill({ name: "pdf-two", goal_pattern: "extract tables from PDF reports" });
      await newSkill({
        name: "theirs",
        owner_id: stranger.id,
        goal_pattern: "extract tables from PDF documents",
      });

      expect(await skills.searchByGoal(owner, "extract tables")).toHaveLength(2);
      expect(await skills.searchByGoal(owner, "extract tables", { limit: 1 })).toHaveLength(1);
      expect(await skills.searchByGoal(stranger.id, "extract tables")).toHaveLength(1);
    });

    it("patches recipe fields and bumps updated_at", async () => {
      const skill = await newSkill();

      const updated = await skills.update(skill.id, {
        goal_pattern: "extract tables from PDF and DOCX",
        install_steps: "pip install -e .[docx]",
        invocation: "python -m pdftools extract --any",
        repo_ref: "v3",
      });

      expect(updated).toMatchObject({
        goal_pattern: "extract tables from PDF and DOCX",
        install_steps: "pip install -e .[docx]",
        invocation: "python -m pdftools extract --any",
        repo_ref: "v3",
        name: "pdf-tables",
      });
      expect(updated.updated_at.getTime()).toBeGreaterThanOrEqual(
        skill.updated_at.getTime(),
      );
    });

    it("records publication, and leaves it alone on a later unrelated patch", async () => {
      const skill = await newSkill();
      const publishedAt = new Date("2026-06-01T00:00:00Z");

      const published = await skills.update(skill.id, {
        published_to: "community",
        published_pr: "https://github.com/beevibe-ai/skills/pull/7",
        published_at: publishedAt,
      });
      expect(published).toMatchObject({
        published_to: "community",
        published_pr: "https://github.com/beevibe-ai/skills/pull/7",
      });
      expect(published.published_at?.toISOString()).toBe(publishedAt.toISOString());

      // Same null-is-no-change rule as repo_run — unpublishing needs an
      // explicit column write, not a null patch.
      const repatched = await skills.update(skill.id, {
        invocation: "x",
        published_to: null,
        published_pr: null,
        published_at: null,
      });
      expect(repatched.published_to).toBe("community");
      expect(repatched.published_pr).toBe("https://github.com/beevibe-ai/skills/pull/7");
    });

    it("throws on updating a skill that doesn't exist", async () => {
      await expect(skills.update("skill_missing", { repo_ref: "v1" })).rejects.toThrow(
        "learned_skill skill_missing not found",
      );
    });

    it("deletes, and deleting a missing row is a no-op", async () => {
      const skill = await newSkill();

      await skills.delete(skill.id);
      expect(await skills.findById(skill.id)).toBeUndefined();
      await expect(skills.delete("skill_missing")).resolves.toBeUndefined();
    });

    it("nulls source_run_id rather than cascading when the run is deleted", async () => {
      const run = await newRun();
      const skill = await newSkill({ source_run_id: run.id });

      await pool.query(`DELETE FROM repo_run WHERE id = $1`, [run.id]);

      const reloaded = await skills.findById(skill.id);
      expect(reloaded).toBeDefined();
      expect(reloaded?.source_run_id).toBeUndefined();
    });
  });

  // ── skill_outcome ──────────────────────────────────────────────────────

  describe("PostgresSkillOutcomeRepository", () => {
    it("upserts by (skill, run) so a re-review replaces the verdict", async () => {
      const skill = await newSkill();
      const run = await newRun();

      const first = await outcomes.upsert({
        id: skillOutcomeId(),
        learned_skill_id: skill.id,
        repo_run_id: run.id,
        outcome: "revised",
      });
      const second = await outcomes.upsert({
        id: skillOutcomeId(),
        learned_skill_id: skill.id,
        repo_run_id: run.id,
        outcome: "approved",
        reviewer_id: owner,
      });

      // The conflict target keeps the original row's id; only the verdict
      // and its metadata move.
      expect(second.id).toBe(first.id);
      expect(second.outcome).toBe("approved");
      expect(second.reviewer_id).toBe(owner);
      expect(await outcomes.listBySkill(skill.id)).toHaveLength(1);
    });

    it("leaves optional columns undefined when unset", async () => {
      const skill = await newSkill();
      const run = await newRun();

      const outcome = await outcomes.upsert({
        id: skillOutcomeId(),
        learned_skill_id: skill.id,
        repo_run_id: run.id,
        outcome: "rejected",
      });

      expect(outcome.work_product_id).toBeUndefined();
      expect(outcome.reviewer_id).toBeUndefined();
      expect(outcome.recorded_at).toBeInstanceOf(Date);
    });

    it("lists a skill's outcomes newest-first, scoped and capped", async () => {
      const skill = await newSkill();
      const otherSkill = await newSkill({ name: "other" });
      const runA = await newRun();
      const runB = await newRun();
      const runC = await newRun();
      const a = await outcomes.upsert({
        id: skillOutcomeId(),
        learned_skill_id: skill.id,
        repo_run_id: runA.id,
        outcome: "approved",
      });
      const b = await outcomes.upsert({
        id: skillOutcomeId(),
        learned_skill_id: skill.id,
        repo_run_id: runB.id,
        outcome: "rejected",
      });
      await outcomes.upsert({
        id: skillOutcomeId(),
        learned_skill_id: otherSkill.id,
        repo_run_id: runC.id,
        outcome: "approved",
      });
      await pool.query(`UPDATE skill_outcome SET recorded_at = $2 WHERE id = $1`, [
        a.id,
        new Date("2026-01-01T00:00:00Z"),
      ]);
      await pool.query(`UPDATE skill_outcome SET recorded_at = $2 WHERE id = $1`, [
        b.id,
        new Date("2026-02-01T00:00:00Z"),
      ]);

      expect((await outcomes.listBySkill(skill.id)).map((o) => o.id)).toEqual([b.id, a.id]);
      expect(await outcomes.listBySkill(skill.id, { limit: 1 })).toHaveLength(1);
      expect(await outcomes.listBySkill("skill_missing")).toEqual([]);
    });

    it("aggregates counts per verdict alongside the recent rows", async () => {
      const skill = await newSkill();
      const verdicts = [
        "approved",
        "approved",
        "approved",
        "revised",
        "rejected",
      ] as const;
      for (const outcome of verdicts) {
        const run = await newRun();
        await outcomes.upsert({
          id: skillOutcomeId(),
          learned_skill_id: skill.id,
          repo_run_id: run.id,
          outcome,
        });
      }

      const stats = await outcomes.statsForSkill(skill.id);

      expect(stats).toMatchObject({ total: 5, approved: 3, revised: 1, rejected: 1 });
      expect(stats.recent).toHaveLength(5);
      expect(await outcomes.statsForSkill(skill.id, { recentLimit: 2 })).toMatchObject({
        total: 5,
        recent: expect.any(Array),
      });
      expect((await outcomes.statsForSkill(skill.id, { recentLimit: 2 })).recent).toHaveLength(
        2,
      );
    });

    it("reports all-zero stats for a skill nobody has reviewed", async () => {
      const skill = await newSkill();

      expect(await outcomes.statsForSkill(skill.id)).toEqual({
        total: 0,
        approved: 0,
        revised: 0,
        rejected: 0,
        recent: [],
      });
    });

    it("cascades outcomes away with their skill", async () => {
      const skill = await newSkill();
      const run = await newRun();
      await outcomes.upsert({
        id: skillOutcomeId(),
        learned_skill_id: skill.id,
        repo_run_id: run.id,
        outcome: "approved",
      });

      await skills.delete(skill.id);

      expect(await outcomes.listBySkill(skill.id)).toEqual([]);
    });
  });

  it("newSkillOutcomeId mints a usable prefixed id", async () => {
    const skill = await newSkill();
    const run = await newRun();
    const id = newSkillOutcomeId();

    expect(id).toMatch(/^sout_/);
    expect(newSkillOutcomeId()).not.toBe(id);
    // It's the same generator the table accepts, not just a lookalike.
    const outcome = await outcomes.upsert({
      id,
      learned_skill_id: skill.id,
      repo_run_id: run.id,
      outcome: "approved",
    });
    expect(outcome.id).toBe(id);
  });
});
