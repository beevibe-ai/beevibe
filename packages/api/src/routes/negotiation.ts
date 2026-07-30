/**
 * Human-facing negotiation review (read-only).
 *
 *   GET /negotiation/:id  → { ok: true, negotiation: NegotiationReview }
 *
 * Pairs with the /negotiations/:id web page — surfaces the full round
 * transcript + agent names + linked escalation id (when escalated) so a
 * human can click into a mesh row and see what's being discussed.
 */

import { Router, type RequestHandler } from "express";
import {
  type NegotiationService,
  NegotiationNotFoundError,
} from "@beevibe/core/services/negotiation-service";
import { requireHuman } from "../auth/middleware.js";
import { requireParam } from "./http-errors.js";

export interface NegotiationRoutesDeps {
  authMiddleware: RequestHandler;
  negotiationService: NegotiationService;
}

export function createNegotiationRouter(deps: NegotiationRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get("/:id", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = requireParam(req, res, "id", "missing_negotiation_id");
    if (!id) return;
    try {
      const negotiation = await deps.negotiationService.getReview(id);
      res.json({ ok: true, negotiation });
    } catch (err) {
      if (err instanceof NegotiationNotFoundError) {
        res.status(404).json({ error: "negotiation_not_found", message: err.message });
        return;
      }
      console.error("[negotiation route]", err);
      res.status(500).json({
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
