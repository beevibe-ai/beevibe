/**
 * Runtimes panel surface — bv_u_ only. Mirrors the data on
 * Settings → Runtimes:
 *
 *   GET  /runtimes              list the caller's daemons + their
 *                               runtimes, enriched with online status
 *                               from the in-memory DaemonHub
 *   POST /runtimes/:id/revoke   revoke a daemon by id (`:id` is
 *                               `daemon_id`, not `runtime_id` — the
 *                               token lives on the daemon row, so
 *                               revoking the daemon kills auth for
 *                               every runtime under it)
 *
 * Online status is best-effort: it reflects the local instance's hub
 * only. Phase 6 federation will gossip per-runtime liveness across
 * instances. For v1 (single-instance API), the local hub IS the truth.
 */

import { Router, type RequestHandler } from "express";
import type {
  DaemonRepository,
  Runtime,
  RuntimeRepository,
} from "@beevibe/core";
import { requireHuman } from "../auth/middleware.js";
import type { DaemonHub } from "../runtime/hub.js";

export interface RuntimesRoutesDeps {
  authMiddleware: RequestHandler;
  daemonRepo: DaemonRepository;
  runtimeRepo: RuntimeRepository;
  hub: DaemonHub;
}

export interface RuntimePanelEntry {
  id: string;
  cli: string;
  cli_version: string | null;
  last_heartbeat: string | null;
  /** True iff a daemon WS client subscribed to this runtime is connected. */
  online: boolean;
  capabilities: Record<string, unknown>;
  created_at: string;
}

export interface DaemonPanelEntry {
  id: string;
  device_name: string;
  external_id: string;
  last_seen_at: string | null;
  created_at: string;
  runtimes: RuntimePanelEntry[];
}

export interface RuntimesListResponse {
  ok: true;
  daemons: DaemonPanelEntry[];
}

function projectRuntime(r: Runtime, online: boolean): RuntimePanelEntry {
  return {
    id: r.id,
    cli: r.cli,
    cli_version: r.cli_version ?? null,
    last_heartbeat: r.last_heartbeat ? r.last_heartbeat.toISOString() : null,
    online,
    capabilities: r.capabilities,
    created_at: r.created_at.toISOString(),
  };
}

export function createRuntimesRouter(deps: RuntimesRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get("/", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const daemons = await deps.daemonRepo.listActiveByOwner(req.caller.personId);
    if (daemons.length === 0) {
      res.json({ ok: true, daemons: [] } satisfies RuntimesListResponse);
      return;
    }
    // Parallel runtime lookups — one query per daemon. The daemon count
    // per user is bounded by hardware (one per machine), so N here is
    // <10 in practice.
    const projected: DaemonPanelEntry[] = await Promise.all(
      daemons.map(async (d) => {
        const runtimes = await deps.runtimeRepo.listByDaemon(d.id);
        return {
          id: d.id,
          device_name: d.device_name,
          external_id: d.external_id,
          last_seen_at: d.last_seen_at ? d.last_seen_at.toISOString() : null,
          created_at: d.created_at.toISOString(),
          runtimes: runtimes.map((r) => projectRuntime(r, deps.hub.isOnline(r.id))),
        };
      }),
    );
    res.json({ ok: true, daemons: projected } satisfies RuntimesListResponse);
  });

  router.post("/:id/revoke", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_daemon_id" });
      return;
    }
    const daemon = await deps.daemonRepo.findById(id);
    if (!daemon) {
      res.status(404).json({ error: "daemon_not_found" });
      return;
    }
    if (daemon.owner_person_id !== req.caller.personId) {
      // Don't leak existence to non-owners — same shape as 404.
      res.status(404).json({ error: "daemon_not_found" });
      return;
    }
    if (daemon.revoked_at) {
      // Idempotent: already revoked is success, not error.
      res.json({ ok: true, daemon_id: id, already_revoked: true });
      return;
    }
    await deps.daemonRepo.revoke(id);
    // The daemon's bv_d_ token now fails findByTokenHash (filters
    // revoked_at IS NULL), so subsequent /runtime/* calls and the WS
    // ping/pong will be rejected. Existing in-flight sessions on this
    // daemon keep running locally — they're CLI subprocesses we can't
    // remotely kill — but no NEW sessions can be claimed.
    res.json({ ok: true, daemon_id: id, already_revoked: false });
  });

  return router;
}
