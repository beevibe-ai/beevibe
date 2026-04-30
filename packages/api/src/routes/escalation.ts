/**
 * Human escalation resolution route (M6.4).
 *
 *   POST /escalation/:id/resolve
 *     body: {
 *       source: 'initiator' | 'counterparty' | 'human',
 *       source_index?: number,    // when source ∈ {initiator, counterparty}
 *       edited_title?: string,    // optional override of original
 *       edited_description?: string,
 *       title?: string,           // required when source === 'human'
 *       description?: string,
 *       resolution_notes?: string,
 *     }
 *
 * Calls EscalationService.resolve which writes DB rows ONLY (no spawning).
 * Re-queues initiator's task + creates synthetic task for counterparty;
 * executor picks both up within ≤30s.
 */

import { Router, type RequestHandler } from "express";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  type EscalationService,
  type ResolveSelector,
  EscalationNotFoundError,
  EscalationStateError,
  NegotiationNotFoundError,
} from "@beevibe/core/services/escalation-service";
import { requireHuman } from "../auth/middleware.js";

export interface EscalationRoutesDeps {
  authMiddleware: RequestHandler;
  escalationService: EscalationService;
  pool: Pool;
}

function buildSelector(body: unknown):
  | { ok: true; selector: ResolveSelector }
  | { ok: false; error: string; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "missing_body", message: "POST body required" };
  }
  const b = body as Record<string, unknown>;
  const source = b.source;

  if (source === "human") {
    if (typeof b.title !== "string" || typeof b.description !== "string") {
      return {
        ok: false,
        error: "invalid_human_resolution",
        message: "source='human' requires title + description (strings)",
      };
    }
    return {
      ok: true,
      selector: { source: "human", title: b.title, description: b.description },
    };
  }

  if (source === "initiator" || source === "counterparty") {
    if (typeof b.source_index !== "number") {
      return {
        ok: false,
        error: "invalid_source_index",
        message: `source='${source}' requires source_index (number)`,
      };
    }
    return {
      ok: true,
      selector: {
        source,
        source_index: b.source_index,
        edited_title:
          typeof b.edited_title === "string" ? b.edited_title : undefined,
        edited_description:
          typeof b.edited_description === "string"
            ? b.edited_description
            : undefined,
      },
    };
  }

  return {
    ok: false,
    error: "invalid_source",
    message: "source must be 'initiator' | 'counterparty' | 'human'",
  };
}

export function createEscalationRouter(deps: EscalationRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.post("/:id/resolve", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_escalation_id" });
      return;
    }

    const selectorResult = buildSelector(req.body);
    if (!selectorResult.ok) {
      res.status(400).json({ error: selectorResult.error, message: selectorResult.message });
      return;
    }

    try {
      const result = await deps.escalationService.resolve({
        escalationId: id,
        personId: req.caller.personId,
        selector: selectorResult.selector,
        notes:
          typeof req.body?.resolution_notes === "string"
            ? req.body.resolution_notes
            : undefined,
      });

      // Notify any future M8 web-UI listeners. Zero cost in M6.
      await deps.pool.query(`SELECT pg_notify('escalation_resolved', $1)`, [id]);

      res.json({
        ok: true,
        escalation: {
          id: result.escalation.id,
          status: result.escalation.status,
          resolution_proposal: result.escalation.resolution_proposal,
          resolution_notes: result.escalation.resolution_notes,
        },
        a_task_id: result.initiatorTaskId,
        b_task_id: result.counterpartyTaskId,
        note: "Both sides will resume via executor in ≤30s.",
      });
    } catch (err) {
      if (err instanceof EscalationNotFoundError) {
        res.status(404).json({ error: "escalation_not_found", message: err.message });
        return;
      }
      if (err instanceof NegotiationNotFoundError) {
        res.status(404).json({ error: "negotiation_not_found", message: err.message });
        return;
      }
      if (err instanceof EscalationStateError) {
        res.status(409).json({ error: "invalid_state", message: err.message });
        return;
      }
      console.error("[escalation route]", err);
      res.status(500).json({
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
