/**
 * Single work product view — used by the dedicated detail page.
 *
 * `body` is populated from the `work_product.body` column when the
 * specialist persisted content directly. As a fallback, if the column is
 * empty and `url` is a `file://` link (older work products written to an
 * agent workspace), the file is read from disk inline.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { WorkProductType } from "@beevibe/core";

export interface WorkProductDetail {
  id: string;
  task_id: string;
  task_short_id: string;
  task_title: string;
  agent_id: string;
  agent_label: string;
  type: WorkProductType;
  title: string;
  summary?: string;
  url?: string;
  provider?: string;
  external_id?: string;
  /**
   * Full deliverable content. Sourced from `work_product.body` when set;
   * otherwise falls back to reading a `file://` URL from disk. Truncated
   * to 256 KB.
   */
  body?: string;
  /** True when `url` is file:// — UI uses this to suppress an unclickable link. */
  url_is_local: boolean;
  created_at: string;
  updated_at: string;
}

const SQL = /* sql */ `
SELECT
  wp.id, wp.task_id, wp.agent_id, wp.type, wp.title, wp.summary, wp.body,
  wp.url, wp.provider, wp.external_id, wp.created_at, wp.updated_at,
  t.title AS task_title,
  a.name  AS agent_label
FROM work_product wp
JOIN task  t ON t.id = wp.task_id
JOIN agent a ON a.id = wp.agent_id
WHERE wp.id = $1
`;

interface Row {
  id: string;
  task_id: string;
  agent_id: string;
  type: WorkProductType;
  title: string;
  summary: string | null;
  body: string | null;
  url: string | null;
  provider: string | null;
  external_id: string | null;
  created_at: Date;
  updated_at: Date;
  task_title: string;
  agent_label: string;
}

const MAX_BODY_BYTES = 256 * 1024;

function deriveTaskShortId(id: string): string {
  return id.replace(/^[a-z]+_/, "").slice(0, 6);
}

function truncateToMax(body: string | null | undefined): string | undefined {
  if (!body) return undefined;
  if (Buffer.byteLength(body, "utf-8") <= MAX_BODY_BYTES) return body;
  const buf = Buffer.from(body, "utf-8");
  return buf.subarray(0, MAX_BODY_BYTES).toString("utf-8") + "\n\n[truncated]";
}

async function tryReadFileUrl(url: string): Promise<string | undefined> {
  if (!url.startsWith("file://")) return undefined;
  try {
    const path = fileURLToPath(url);
    const buf = await readFile(path);
    return truncateToMax(buf.toString("utf-8"));
  } catch {
    return undefined;
  }
}

export async function getWorkProduct(
  pool: Pool,
  id: string,
): Promise<WorkProductDetail | undefined> {
  const { rows } = await pool.query<Row>(SQL, [id]);
  const row = rows[0];
  if (!row) return undefined;
  const url = row.url ?? undefined;
  const url_is_local = !!url && url.startsWith("file://");
  const body =
    truncateToMax(row.body) ?? (url_is_local ? await tryReadFileUrl(url!) : undefined);

  return {
    id: row.id,
    task_id: row.task_id,
    task_short_id: deriveTaskShortId(row.task_id),
    task_title: row.task_title,
    agent_id: row.agent_id,
    agent_label: row.agent_label,
    type: row.type,
    title: row.title,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(url ? { url } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.external_id ? { external_id: row.external_id } : {}),
    ...(body ? { body } : {}),
    url_is_local,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
