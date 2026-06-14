/**
 * Public newsletter capture for the community layer.
 *
 * This intentionally stays small: validate + upsert an email into Postgres.
 * Delivery tooling (beehiiv/Buttondown/Customer.io/etc.) can sync from this
 * table later without coupling the API server to a vendor on day one.
 */

import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import type { Pool } from "@beevibe/core/adapters/postgres";

export interface NewsletterRoutesDeps {
  pool: Pick<Pool, "query">;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;

function makeSubscriberId(): string {
  return `nl_${randomUUID().replace(/-/g, "")}`;
}

function handleError(err: unknown, res: Response): void {
  console.error("[newsletter route]", err);
  res.status(500).json({
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
}

export function createNewsletterRouter(deps: NewsletterRoutesDeps): Router {
  const router = Router();

  router.post("/newsletter/subscribe", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;

      // Bot trap: real clients leave this empty. Pretend success so bots
      // don't learn which field gave them away.
      if (typeof body.website === "string" && body.website.trim().length > 0) {
        res.json({ ok: true });
        return;
      }

      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const source =
        typeof body.source === "string" && SOURCE_RE.test(body.source.trim())
          ? body.source.trim()
          : "community";

      if (!email || !EMAIL_RE.test(email)) {
        res
          .status(400)
          .json({ error: "invalid_email", message: "valid email required" });
        return;
      }

      await deps.pool.query(
        `INSERT INTO newsletter_subscriber (id, email, source)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE
           SET source = EXCLUDED.source,
               updated_at = now()`,
        [makeSubscriberId(), email, source],
      );

      res.json({ ok: true, subscriber: { email, source } });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}
