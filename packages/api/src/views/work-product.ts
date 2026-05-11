/**
 * Single work product view — used by the dedicated detail page.
 *
 * For `file://` URLs (the most common case — agents write briefings to
 * their workspace), tries to read the file content from disk and inline
 * it. Fails open: a missing/unreadable file just means `body` is empty
 * and the page falls back to the summary blob. This is per-agent
 * sandboxed already, no extra auth.
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
   * Inlined contents of the file the work product points at, when the
   * URL is `file://` and the file is readable. Lets the web render the
   * full briefing/audit/document inline. Truncated to 256 KB (way more
   * than any reasonable briefing).
   */
  body?: string;
  /** True when `url` is file:// — UI uses this to suppress an unclickable link. */
  url_is_local: boolean;
  created_at: string;
  updated_at: string;
}

const SQL = /* sql */ `
SELECT
  wp.id, wp.task_id, wp.agent_id, wp.type, wp.title, wp.summary, wp.url,
  wp.provider, wp.external_id, wp.created_at, wp.updated_at,
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

async function tryReadFileUrl(url: string): Promise<string | undefined> {
  if (!url.startsWith("file://")) return undefined;
  try {
    const path = fileURLToPath(url);
    const buf = await readFile(path);
    if (buf.byteLength > MAX_BODY_BYTES) {
      return buf.subarray(0, MAX_BODY_BYTES).toString("utf-8") + "\n\n[truncated]";
    }
    return buf.toString("utf-8");
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
  const body = url_is_local ? await tryReadFileUrl(url!) : undefined;

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
