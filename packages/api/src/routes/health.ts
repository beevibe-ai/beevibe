import type { Request, Response } from "express";

/**
 * GET /health — public, no auth. Operator convenience for readiness probes.
 */
export function healthRoute(_req: Request, res: Response): void {
  res.json({ ok: true, version: "0.0.1" });
}
