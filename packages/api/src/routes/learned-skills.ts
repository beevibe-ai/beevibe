/**
 * /learned-skills REST surface — Capability Network Layer 2 (#149).
 *
 *   GET    /learned-skills               list caller's saved skills
 *   POST   /learned-skills               create a skill from a repo_run
 *   DELETE /learned-skills/:id           delete a saved skill
 *   POST   /learned-skills/:id/publish   file a PR to beevibe-capabilities
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Router, type RequestHandler, type Response } from "express";
import {
  learnedSkillId as newLearnedSkillId,
  type LearnedSkillRepository,
  type RepoRun,
  type RepoRunRepository,
  type WorkProductRepository,
} from "@beevibe/core";
import { requireHuman } from "../auth/middleware.js";
import { readArtifactBody } from "../views/work-product.js";
import { invalidBody, loadOwned, requireParam } from "./http-errors.js";

export interface LearnedSkillsRouterDeps {
  authMiddleware: RequestHandler;
  learnedSkillRepo: LearnedSkillRepository;
  repoRunRepo: RepoRunRepository;
  /**
   * Used to find the run's exported artifact and inline its markdown
   * as the SKILL.md body — the agent already wrote the skill content;
   * we shouldn't throw it away and regenerate a template.
   */
  workProductRepo: WorkProductRepository;
  /**
   * Root directory of the beevibe repo checkout — skills/learned/
   * is written relative to this. Defaults to process.cwd().
   */
  repoRoot?: string;
}

export function createLearnedSkillsRouter(deps: LearnedSkillsRouterDeps): Router {
  const router = Router();
  const repoRoot = resolve(deps.repoRoot ?? process.cwd());
  router.use(deps.authMiddleware);

  /**
   * `loadOwned` bound to the learned-skill repo — `DELETE /:id` and
   * `POST /:id/publish` passed byte-identical arguments.
   */
  const loadOwnedSkill = (res: Response, personId: string, id: string) =>
    loadOwned(
      res,
      personId,
      () => deps.learnedSkillRepo.findById(id),
      (sk) => sk.owner_id,
      "not_found",
    );

  // GET /learned-skills
  router.get("/", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const skills = await deps.learnedSkillRepo.listByOwner(req.caller!.personId);
      res.status(200).json({ skills });
    } catch (err) {
      console.error("[learned-skills/list]", err);
      res.status(500).json({ error: "list_failed" });
    }
  });

  // POST /learned-skills — create a skill from a successful repo_run.
  // Body: { name, goal_pattern, repo_run_id }
  router.post("/", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const body = req.body as Partial<{
      name: string;
      goal_pattern: string;
      repo_run_id: string;
    }>;
    if (!body.name || !body.goal_pattern || !body.repo_run_id) {
      invalidBody(res, "name, goal_pattern, repo_run_id required");
      return;
    }
    // Validate slug — lowercase alphanum + hyphens only.
    if (!/^[a-z0-9-]{2,64}$/.test(body.name)) {
      res.status(400).json({ error: "invalid_name", message: "name must be 2-64 lowercase alphanumeric + hyphens" });
      return;
    }

    try {
      const run = await deps.repoRunRepo.findById(body.repo_run_id);
      if (!run) {
        res.status(404).json({ error: "repo_run_not_found" });
        return;
      }
      if (run.status !== "succeeded") {
        res.status(409).json({ error: "run_not_succeeded", current_status: run.status });
        return;
      }

      // Check for existing skill with the same name for this owner.
      const existing = await deps.learnedSkillRepo.findByOwnerAndName(
        req.caller!.personId,
        body.name,
      );
      if (existing) {
        res.status(409).json({ error: "name_taken", message: `A skill named '${body.name}' already exists.` });
        return;
      }

      const skill = await deps.learnedSkillRepo.create({
        id: newLearnedSkillId(),
        name: body.name,
        goal_pattern: body.goal_pattern,
        repo_url: run.repo_url,
        repo_ref: run.repo_ref ?? "HEAD",
        install_steps: run.install_log ?? "(see run transcript)",
        invocation: run.invocation ?? "(see run transcript)",
        source_run_id: run.id,
        owner_id: req.caller!.personId,
      });

      // Prefer the agent's exported artifact as SKILL.md content; fall
      // back to the generic template when no artifact body is reachable.
      try {
        const skillDir = join(repoRoot, "skills", "learned", body.name);
        await mkdir(skillDir, { recursive: true });
        const artifactBody = await tryFindArtifactBody(deps.workProductRepo, run);
        const md = artifactBody
          ? wrapArtifactAsSkillMd(skill.name, skill.goal_pattern, skill.repo_url, skill.repo_ref, artifactBody)
          : generateSkillMd(skill.name, skill.goal_pattern, skill.repo_url, skill.repo_ref, skill.install_steps, skill.invocation);
        await writeFile(join(skillDir, "SKILL.md"), md, "utf8");
      } catch (writeErr) {
        // Non-fatal: the DB row is the source of truth; filesystem
        // sync failure is a warning.
        console.warn("[learned-skills/create] SKILL.md write failed:", writeErr);
      }

      // Back-link repo_run to the learned skill.
      await deps.repoRunRepo.update(run.id, { learned_skill_id: skill.id });

      res.status(201).json({ skill });
    } catch (err) {
      console.error("[learned-skills/create]", err);
      res.status(500).json({ error: "create_failed" });
    }
  });

  // DELETE /learned-skills/:id
  router.delete("/:id", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = requireParam(req, res, "id", "missing_id");
    if (!id) return;
    try {
      const skill = await loadOwnedSkill(res, req.caller!.personId, id);
      if (!skill) return;
      await deps.learnedSkillRepo.delete(id);
      res.status(204).send();
    } catch (err) {
      console.error("[learned-skills/delete]", err);
      res.status(500).json({ error: "delete_failed" });
    }
  });

  // POST /learned-skills/:id/publish — attempt to open a PR against
  // beevibe-ai/beevibe-capabilities via `gh pr create`.
  // Requires BEEVIBE_REGISTRY_TOKEN env var (gh auth token). If absent,
  // returns a tarball-style instructions response so the user can PR manually.
  router.post("/:id/publish", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = requireParam(req, res, "id", "missing_id");
    if (!id) return;
    try {
      const skill = await loadOwnedSkill(res, req.caller!.personId, id);
      if (!skill) return;

      const token = process.env.BEEVIBE_REGISTRY_TOKEN;
      const md = generateSkillMd(
        skill.name, skill.goal_pattern, skill.repo_url, skill.repo_ref,
        skill.install_steps, skill.invocation,
      );

      if (!token) {
        // Return the SKILL.md content so the user can PR manually.
        res.status(200).json({
          ok: false,
          reason: "no_token",
          message:
            "Set BEEVIBE_REGISTRY_TOKEN to a GitHub personal access token with repo scope " +
            "to publish automatically. The skill file is included below for a manual PR.",
          skill_md: md,
          target_repo: "beevibe-ai/beevibe-capabilities",
          target_path: `skills/${skill.name}/SKILL.md`,
          instructions:
            `1. Fork https://github.com/beevibe-ai/beevibe-capabilities\n` +
            `2. Create skills/${skill.name}/SKILL.md with the content below\n` +
            `3. Open a PR — title: "feat(skills): add ${skill.name}"`,
        });
        return;
      }

      // Use gh CLI to create a PR.
      const branchName = `add-${skill.name}-${Date.now()}`;
      const prTitle = `feat(skills): add ${skill.name}`;
      const prBody =
        `## New capability: ${skill.name}\n\n` +
        `Goal pattern: ${skill.goal_pattern}\n\n` +
        `Repo: ${skill.repo_url} @ ${skill.repo_ref}\n\n` +
        `🤖 Submitted from a Beevibe instance via /learned-skills/${skill.id}/publish`;

      // gh pr create requires the repo to exist locally or via fork.
      // For MVP, we use the GitHub API directly to create a file + PR.
      const prUrl = await createGitHubPr({
        token,
        owner: "beevibe-ai",
        repo: "beevibe-capabilities",
        branch: branchName,
        path: `skills/${skill.name}/SKILL.md`,
        content: md,
        commitMessage: `feat(skills): add ${skill.name}`,
        prTitle,
        prBody,
      });

      await deps.learnedSkillRepo.update(id, {
        published_to: "community",
        published_pr: prUrl,
        published_at: new Date(),
      });

      res.status(200).json({ ok: true, pr_url: prUrl });
    } catch (err) {
      console.error("[learned-skills/publish]", err);
      res.status(500).json({
        error: "publish_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}

/**
 * Look up the artifact work_product attached to a repo_run and return
 * its body. Returns undefined when no artifact is reachable — the
 * caller falls back to the generic SKILL.md template.
 */
async function tryFindArtifactBody(
  workProductRepo: WorkProductRepository,
  run: RepoRun,
): Promise<string | undefined> {
  if (!run.task_id) return undefined;
  let items;
  try {
    items = await workProductRepo.listByTask(run.task_id);
  } catch {
    return undefined;
  }
  const candidates = items.filter((wp) => wp.type === "artifact");
  const ourRun = candidates.find(
    (wp) => (wp.metadata as Record<string, unknown> | undefined)?.repo_run_id === run.id,
  );
  const chosen = ourRun ?? candidates[0];
  if (!chosen) return undefined;
  try {
    const full = await workProductRepo.findById(chosen.id);
    if (!full) return undefined;
    return readArtifactBody({ body: full.body, url: full.url, metadata: full.metadata });
  } catch {
    return undefined;
  }
}

/**
 * Wrap the agent's artifact body as a Claude Code skill: frontmatter
 * on top, raw artifact body in the middle, provenance footer at the
 * bottom. The artifact already has its own structure (H1, sections,
 * tables) — we don't transform it, just attach the metadata Claude
 * Code's skill-loader expects.
 */
function wrapArtifactAsSkillMd(
  name: string,
  goalPattern: string,
  repoUrl: string,
  repoRef: string,
  artifactBody: string,
): string {
  // Indent goal_pattern continuation lines so the YAML folded scalar
  // stays valid even when the pattern spans multiple lines.
  const yamlGoal = goalPattern.split("\n").map((l) => "  " + l).join("\n");
  const frontmatter = [
    `---`,
    `name: ${name}`,
    `description: >`,
    yamlGoal,
    `source_repo: ${repoUrl}`,
    `repo_ref: ${repoRef}`,
    `captured_at: ${new Date().toISOString()}`,
    `---`,
    ``,
  ].join("\n");
  const footer = [
    ``,
    `---`,
    ``,
    `## Provenance`,
    ``,
    `Captured from a sandboxed \`use_repo\` run. Re-run with:`,
    ``,
    `\`\`\``,
    `use_repo({ goal: "${goalPattern.replace(/"/g, '\\"').slice(0, 200)}", repo_url: "${repoUrl}" })`,
    `\`\`\``,
  ].join("\n");
  return frontmatter + artifactBody.trim() + footer + "\n";
}

/** Generate the SKILL.md content for a learned skill. */
function generateSkillMd(
  name: string,
  goalPattern: string,
  repoUrl: string,
  repoRef: string,
  installSteps: string,
  invocation: string,
): string {
  const title = name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return [
    `---`,
    `name: ${name}`,
    `description: >`,
    `  ${goalPattern}`,
    `source_repo: ${repoUrl}`,
    `repo_ref: ${repoRef}`,
    `---`,
    ``,
    `# ${title}`,
    ``,
    `Use this when the goal is: **${goalPattern}**`,
    ``,
    `## Steps`,
    ``,
    `Call \`use_repo\` with this repo to accomplish the goal:`,
    ``,
    `\`\`\``,
    `use_repo({`,
    `  goal: "${goalPattern}",`,
    `  repo_url: "${repoUrl}"`,
    `})`,
    `\`\`\``,
    ``,
    `The child agent will check out the pinned ref (\`${repoRef.slice(0, 12)}\`) before installing.`,
    ``,
    `## Known install steps`,
    ``,
    `\`\`\`bash`,
    installSteps || "# (see run transcript)",
    `\`\`\``,
    ``,
    `## Known invocation`,
    ``,
    `\`\`\`bash`,
    invocation || "# (see run transcript)",
    `\`\`\``,
  ].join("\n");
}

/**
 * Create a file on a new branch and open a PR via the GitHub API.
 * Requires token with `repo` scope (or `public_repo` for public repos).
 */
async function createGitHubPr(opts: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  content: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
}): Promise<string> {
  const base = `https://api.github.com/repos/${opts.owner}/${opts.repo}`;
  const headers = {
    "Authorization": `token ${opts.token}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // 1. Get default branch SHA to branch from
  const repoRes = await fetch(base, { headers });
  if (!repoRes.ok) throw new Error(`GitHub repo fetch failed: ${repoRes.status}`);
  const repoData = await repoRes.json() as { default_branch: string };
  const defaultBranch = repoData.default_branch ?? "main";

  const refRes = await fetch(`${base}/git/ref/heads/${defaultBranch}`, { headers });
  if (!refRes.ok) throw new Error(`GitHub ref fetch failed: ${refRes.status}`);
  const refData = await refRes.json() as { object: { sha: string } };
  const sha = refData.object.sha;

  // 2. Create the branch
  const branchRes = await fetch(`${base}/git/refs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: `refs/heads/${opts.branch}`, sha }),
  });
  if (!branchRes.ok) throw new Error(`GitHub branch create failed: ${branchRes.status}`);

  // 3. Create the file
  const fileRes = await fetch(`${base}/contents/${opts.path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: opts.commitMessage,
      content: Buffer.from(opts.content, "utf8").toString("base64"),
      branch: opts.branch,
    }),
  });
  if (!fileRes.ok) throw new Error(`GitHub file create failed: ${fileRes.status}`);

  // 4. Open the PR
  const prRes = await fetch(`${base}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: opts.prTitle,
      body: opts.prBody,
      head: opts.branch,
      base: defaultBranch,
    }),
  });
  if (!prRes.ok) throw new Error(`GitHub PR create failed: ${prRes.status}`);
  const prData = await prRes.json() as { html_url: string };
  return prData.html_url;
}
