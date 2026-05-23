/**
 * use_repo MCP tool — the Agent App Store's verb.
 *
 * Capability Network MVP (#149). Lets any agent borrow an arbitrary
 * GitHub repo as a one-shot tool inside a fresh Docker sandbox. The
 * orchestrator runs on the user's daemon, never on the api server, and
 * the agent's host filesystem is never touched.
 *
 * Tool surface:
 *   use_repo({ goal, repo_url, input_url?, input_filename?, limits? })
 *
 * Discovery (picking a repo when the agent doesn't already know one)
 * lives in the `beevibe-discover-repo` skill, not here. The skill tells
 * the agent how to search GitHub, evaluate candidates, and call this
 * tool with a chosen repo_url.
 *
 * Returns immediately with the row ids; the agent polls (or the UI
 * watches the live transcript at /capabilities/runs/:id) for progress.
 */

import {
  repoRunId as newRepoRunId,
  sessionId as newSessionId,
  taskId as newTaskId,
  type AgentRepository,
  type PersonSecretRepository,
  type RepoRunRepository,
  type TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { AgentTool } from "./types.js";

const USE_REPO_SCHEMA = {
  type: "object",
  properties: {
    goal: {
      type: "string",
      description:
        "What you need done, in plain language. Example: 'Extract the " +
        "tables from this PDF as JSON' or 'Download the audio track from " +
        "this YouTube video as mp3.' The child agent reads this and the " +
        "repo's README to figure out how to install + invoke. Be concrete.",
    },
    repo_url: {
      type: "string",
      description:
        "GitHub HTTPS URL of the repo to borrow. Required. Pick one with " +
        "the beevibe-discover-repo skill if you don't already know one.",
    },
    input_url: {
      type: "string",
      description:
        "Optional URL to download into /sandbox/inputs/ before the child " +
        "agent starts (e.g. the PDF you want extracted). Resolved inside " +
        "the sandbox; the host machine never sees it.",
    },
    input_filename: {
      type: "string",
      description:
        "Optional filename for input_url (defaults to 'input.bin'). The " +
        "child agent is told the full path when present.",
    },
    limits: {
      type: "object",
      properties: {
        wall_clock_minutes: {
          type: "number",
          description: "Hard cap on the whole run. Default 20.",
        },
        max_install_attempts: {
          type: "number",
          description: "Cap retries on `pip install` / `apt-get install` failures. Default 2.",
        },
        disk_mb: {
          type: "number",
          description: "Writable-layer disk cap inside the sandbox, in MB. Default 2048.",
        },
      },
      additionalProperties: false,
    },
    secrets: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional list of env-var names from the caller's secret store to " +
        "inject into the sandbox (set via `docker run --env <NAME>=<VALUE>`). " +
        "Use for repos that need cloud-API credentials: e.g. " +
        "['OPENAI_API_KEY', 'TAVILY_API_KEY'] for the " +
        "architecture-deep-research repo. The named secrets must already " +
        "exist for the caller (the user adds them via /settings → Secrets). " +
        "Unknown names are silently skipped — the run can still proceed " +
        "if the repo can fall back. Values are never logged or surfaced " +
        "in the transcript.",
    },
  },
  required: ["goal", "repo_url"],
  additionalProperties: false,
} as const;

export interface UseRepoContext {
  /** The calling agent (resolved from bv_a_ token). */
  agentId: string;
}

export interface UseRepoServices {
  agentRepo: AgentRepository;
  taskRepo: TaskRepository;
  repoRunRepo: RepoRunRepository;
  dispatchService: DispatchService;
  personSecretRepo: PersonSecretRepository;
}

export function createUseRepoTool(
  ctx: UseRepoContext,
  services: UseRepoServices,
): AgentTool {
  return {
    name: "use_repo",
    description:
      "Run an external GitHub repo as a one-shot tool inside a fresh " +
      "Docker sandbox. The host filesystem is never touched.\n\n" +
      "**This is the sandbox alternative to `brew install`, `apt-get " +
      "install`, `pip install`, etc.** When a tool you need is missing " +
      "from the host (yt-dlp not on PATH, ffmpeg missing, an obscure " +
      "Python lib not pip-installed), call use_repo with the repo URL " +
      "instead of reporting an install blocker — sandboxed installs are " +
      "NOT system installs and don't violate 'no auto-install' rules.\n\n" +
      "The child agent inside the sandbox clones the repo, reads its " +
      "README, installs deps, runs the right command, and exports the " +
      "result. Every shell command and file operation goes through " +
      "sandbox MCP tools (Bash/Read/Edit on the host are denied). The " +
      "artifact lands as a work_product on a container task for human " +
      "review.\n\n" +
      "Pair with `find_repo` when you don't already know which repo to " +
      "use. Otherwise call this directly.\n\n" +
      "Returns { repo_run_id, session_id, task_id, status } immediately. " +
      "Watch the live transcript at /capabilities/runs/<repo_run_id> in " +
      "the UI, or read repo_run.status for completion.",
    schema: USE_REPO_SCHEMA as Record<string, unknown>,
    handler: async (input) => {
      const goal = typeof input.goal === "string" ? input.goal.trim() : "";
      const repoUrl =
        typeof input.repo_url === "string" ? input.repo_url.trim() : "";
      if (!goal) {
        return {
          content: { error: "invalid_goal", message: "goal must be a non-empty string" },
          isError: true,
        };
      }
      if (!repoUrl || !isLikelyGithubUrl(repoUrl)) {
        return {
          content: {
            error: "invalid_repo_url",
            message: "repo_url must be a GitHub HTTPS URL",
          },
          isError: true,
        };
      }

      const inputUrl =
        typeof input.input_url === "string" ? input.input_url.trim() : undefined;
      const inputFilename =
        typeof input.input_filename === "string"
          ? input.input_filename.trim()
          : undefined;
      const limits = parseLimits(input.limits);

      // Look the agent up so we can pin the container task's creator
      // to the actual agent id and confirm the caller exists.
      const agent = await services.agentRepo.findById(ctx.agentId);
      if (!agent) {
        return {
          content: { error: "agent_not_found", message: "calling agent not found" },
          isError: true,
        };
      }

      // Per-run secret resolution. The handler ONLY validates that the
      // requested names exist in the caller's secret store (existence
      // check, NO decryption). The names get persisted on repo_run.
      // requested_secret_names; composeDispatchPayload at /runtime/claim
      // time does the actual decryption and puts the values into
      // DispatchPayload.run_repo.sandbox_env. That keeps decrypted
      // values out of any DB row.
      //
      // Unknown names are reported in missing_secret_names but don't
      // block dispatch — the run can still try if the repo has a
      // fallback. Whether to fail is the calling agent's call (it can
      // re-prompt the user to add the missing key).
      const requestedSecrets = Array.isArray(input.secrets)
        ? Array.from(
            new Set(
              (input.secrets as unknown[]).filter(
                (s): s is string => typeof s === "string" && s.length > 0,
              ),
            ),
          )
        : [];
      const resolvedSecretNames: string[] = [];
      const missingSecrets: string[] = [];
      if (requestedSecrets.length > 0) {
        let existingNames: Set<string>;
        try {
          const listed = await services.personSecretRepo.listByPerson(
            agent.owner_id,
          );
          existingNames = new Set(listed.map((s) => s.name));
        } catch (err) {
          return {
            content: {
              error: "secret_lookup_failed",
              message: err instanceof Error ? err.message : String(err),
            },
            isError: true,
          };
        }
        for (const name of requestedSecrets) {
          if (existingNames.has(name)) resolvedSecretNames.push(name);
          else missingSecrets.push(name);
        }
      }

      // Container task — the artifact has to live somewhere, and
      // work_product requires a task_id. Title is a short cut of the
      // goal so the inbox row is scannable.
      const containerTask = await services.taskRepo.create({
        id: newTaskId(),
        title: containerTaskTitle(goal),
        description: goal,
        priority: "medium",
        assignee_id: agent.id,
        creator_id: agent.id,
        creator_type: "agent",
      });

      // Order matters: repo_run.session_id has a FK to session.id, so
      // the session row has to exist BEFORE the repo_run insert.
      // dispatchService.dispatchTask creates the session row (under our
      // pre-minted sessionIdOverride), then we insert repo_run.
      //
      // The daemon claims via polling, so the small window between
      // dispatch returning and the repo_run insert is OK in practice —
      // if the daemon races us, composeDispatchPayload returns null
      // (no repo_run found by session_id) and marks the session failed,
      // which the agent then sees as a retryable error.
      const sessionIdValue = newSessionId();
      const repoRunIdValue = newRepoRunId();

      try {
        await services.dispatchService.dispatchTask({
          agentId: agent.id,
          type: "run_repo",
          intent: goal,
          task: containerTask,
          reason: { kind: "fresh" },
          sessionIdOverride: sessionIdValue,
        });
      } catch (err) {
        return {
          content: {
            error: "dispatch_failed",
            message: err instanceof Error ? err.message : String(err),
          },
          isError: true,
        };
      }

      try {
        await services.repoRunRepo.create({
          id: repoRunIdValue,
          session_id: sessionIdValue,
          task_id: containerTask.id,
          agent_id: agent.id,
          goal,
          repo_url: repoUrl,
          status: "pending",
          // Only persist the names that actually resolved. Missing names
          // would just be dead weight at claim time; the agent already
          // got told about them in the return payload.
          requested_secret_names:
            resolvedSecretNames.length > 0 ? resolvedSecretNames : undefined,
        });
      } catch (err) {
        // Session row landed but repo_run insert failed — orphan
        // session. composeDispatchPayload will find no repo_run and
        // return null, marking the session failed. Self-recovers, but
        // surface the error so the agent doesn't silently wait.
        return {
          content: {
            error: "repo_run_create_failed",
            message: err instanceof Error ? err.message : String(err),
          },
          isError: true,
        };
      }

      return {
        content: {
          repo_run_id: repoRunIdValue,
          session_id: sessionIdValue,
          task_id: containerTask.id,
          status: "pending",
          watch_url: `/capabilities/runs/${repoRunIdValue}`,
          // Hint to the agent: don't keep calling use_repo while one
          // is in flight; poll repo_run.status or wait for the work
          // product to land on the task.
          note:
            "Sandbox run started. The transcript streams to the UI; poll " +
            "repo_run.status (or wait for the artifact work_product on the " +
            "task) before deciding next steps.",
          limits,
          input_url: inputUrl,
          input_filename: inputFilename,
          // Echo back the secret names that were resolved / missed so the
          // agent can tell the user which keys they still need to add
          // (e.g. "I need OPENAI_API_KEY in /settings → Secrets to run
          // ADR end-to-end"). Values are NEVER returned — names only.
          resolved_secret_names: resolvedSecretNames,
          missing_secret_names: missingSecrets,
        },
      };
    },
  };
}

function containerTaskTitle(goal: string): string {
  const cleaned = goal.replace(/\s+/g, " ").trim();
  return cleaned.length > 80 ? cleaned.slice(0, 77) + "…" : cleaned;
}

function isLikelyGithubUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return /(^|\.)github\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

interface ParsedLimits {
  wall_clock_minutes?: number;
  max_install_attempts?: number;
  disk_mb?: number;
}

function parseLimits(raw: unknown): ParsedLimits {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: ParsedLimits = {};
  if (typeof r.wall_clock_minutes === "number" && r.wall_clock_minutes > 0) {
    out.wall_clock_minutes = Math.min(r.wall_clock_minutes, 60);
  }
  if (typeof r.max_install_attempts === "number" && r.max_install_attempts > 0) {
    out.max_install_attempts = Math.min(Math.floor(r.max_install_attempts), 5);
  }
  if (typeof r.disk_mb === "number" && r.disk_mb > 0) {
    out.disk_mb = Math.min(Math.floor(r.disk_mb), 10_000);
  }
  return out;
}
