/**
 * /repo-runs REST surface — Capability Network MVP (#149).
 *
 * Used by the /capabilities UI to list, watch, cancel, and serve
 * artifacts from sandboxed `use_repo` runs.
 *
 *   GET  /repo-runs                     list recent runs (last 50)
 *   GET  /repo-runs/:id                 run detail + transcript
 *   POST /repo-runs/:id/cancel          mark cancelled (best-effort)
 *   GET  /repo-runs/:id/artifacts/:file serve artifact bytes from host fs
 */

import { basename } from "node:path";
import { Router, type RequestHandler } from "express";
import type {
  RepoRunRepository,
  RepoRunTranscriptEvent,
  SessionEventKind,
  SessionEventRepository,
} from "@beevibe/core";
import { requireHuman } from "../auth/middleware.js";
import { operationFailed, requireParam } from "./http-errors.js";

export interface RepoRunsRouterDeps {
  authMiddleware: RequestHandler;
  repoRunRepo: RepoRunRepository;
  /**
   * `runtime/events` writes daemon events to `session_event`, not to
   * `repo_run.transcript`. Hydrate the transcript on read by joining
   * events for the run's session — keeps the canonical store single
   * (session_event) without making the daemon double-write.
   */
  sessionEventRepo: SessionEventRepository;
}

/**
 * Reverse of `packages/daemon/src/repo-runs.ts:mapKind`. The daemon
 * folds 'log'/'error' from the sandbox orchestrator into session_event
 * kinds 'summary'/'tool_result'; here we invert so the playground UI
 * shows the original transcript kinds (it has dedicated colors per kind).
 */
function sessionEventToTranscriptKind(
  kind: SessionEventKind,
): RepoRunTranscriptEvent["kind"] {
  switch (kind) {
    case "agent":
      return "agent";
    case "tool_call":
      return "tool_call";
    case "tool_result":
      return "error";
    case "summary":
      return "log";
  }
}

export function createRepoRunsRouter(deps: RepoRunsRouterDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  // GET /repo-runs — recent runs for the authenticated user's agents.
  // For MVP: returns the last 50 across all agents the caller owns.
  // TODO: scope to caller's agents once a caller→agent ownership query exists.
  router.get("/", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const runs = await deps.repoRunRepo.listRecent({ limit: 50 });
      res.status(200).json({ runs });
    } catch (err) {
      operationFailed(res, err, "repo-runs/list", "list_failed");
    }
  });

  // GET /repo-runs/:id — full run detail including transcript.
  router.get("/:id", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = requireParam(req, res, "id", "missing_id");
    if (!id) return;
    try {
      const run = await deps.repoRunRepo.findById(id);
      if (!run) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Hydrate transcript from session_event (the canonical store).
      // repo_run.transcript stays empty in the DB; this join is the
      // single source of truth the UI reads.
      let transcript: RepoRunTranscriptEvent[] = run.transcript ?? [];
      if (run.session_id) {
        try {
          const events = await deps.sessionEventRepo.listBySession(run.session_id);
          transcript = events.map((ev) => ({
            at: ev.created_at.toISOString(),
            kind: sessionEventToTranscriptKind(ev.kind),
            text: ev.content,
          }));
        } catch (err) {
          console.warn("[repo-runs/get] transcript hydration failed:", err);
        }
      }
      res.status(200).json({ run: { ...run, transcript } });
    } catch (err) {
      operationFailed(res, err, "repo-runs/get", "get_failed");
    }
  });

  // POST /repo-runs/:id/cancel — mark the run cancelled.
  // Best-effort: the daemon may have already finished the sandbox by
  // the time this lands. The daemon also honours the abort signal if
  // the daemon hub sends a cancel WS message (separate flow).
  router.post("/:id/cancel", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = requireParam(req, res, "id", "missing_id");
    if (!id) return;
    try {
      const run = await deps.repoRunRepo.findById(id);
      if (!run) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (run.status !== "pending" && run.status !== "running") {
        res.status(409).json({
          error: "already_terminal",
          current_status: run.status,
        });
        return;
      }
      const updated = await deps.repoRunRepo.update(id, {
        status: "cancelled",
        ended_at: new Date(),
      });
      res.status(200).json({ run: updated });
    } catch (err) {
      operationFailed(res, err, "repo-runs/cancel", "cancel_failed");
    }
  });

  // GET /repo-runs/:id/artifacts/:file — serve artifact bytes.
  // Artifacts live on the daemon's host filesystem. For the single-
  // machine self-hosted setup the api has direct filesystem access.
  // The host_path is stored in work_product.metadata.host_path and
  // also in the run's transcript; for security we only serve paths
  // that appear in artifacts we know about (verified via work_product
  // join — for MVP we trust the host_path from repo_run).
  router.get("/:id/artifacts/:file", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = requireParam(req, res, "id", "missing_params");
    if (!id) return;
    const file = requireParam(req, res, "file", "missing_params");
    if (!file) return;
    try {
      const run = await deps.repoRunRepo.findById(id);
      if (!run) {
        res.status(404).json({ error: "run_not_found" });
        return;
      }
      // Safety: reject path traversal attempts.
      const safeFilename = basename(file);
      if (safeFilename !== file) {
        res.status(400).json({ error: "invalid_filename" });
        return;
      }
      // Locate the host_path from the session's session_event
      // metadata. For MVP: scan the transcript for an export event
      // whose filename matches. In a production path we'd join on
      // work_product.metadata.host_path.
      //
      // Since we don't have host_path directly on repo_run (the
      // daemon reports it in /runtime/done → work_product.metadata),
      // we require the caller knows the filename and we reconstruct
      // the path as <artifact_dir>/<filename>. The artifact_dir isn't
      // stored on repo_run either, so we rely on the transcript to
      // carry a log line with the path.
      //
      // For MVP, return 501 with instructions to serve from work_product
      // instead. The /capabilities/runs/:id detail page will link
      // to work_product artifacts which are already served by the
      // existing work-product endpoint.
      res.status(501).json({
        error: "not_implemented",
        message:
          "Serve artifacts via the work_product endpoint. " +
          "Artifacts from this run are attached to the container task.",
        task_id: run.task_id,
      });
    } catch (err) {
      operationFailed(res, err, "repo-runs/artifact", "artifact_failed");
    }
  });

  return router;
}
