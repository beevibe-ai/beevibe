/**
 * Single work product view — used by the dedicated detail page.
 *
 * `body` is populated from the `work_product.body` column when the
 * specialist persisted content directly. As a fallback, if the column is
 * empty and `url` is a `file://` link (older work products written to an
 * agent workspace), the file is read from disk inline.
 */

import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { WorkProductType } from "@beevibe/core";
import { deriveShortId } from "./format.js";
import type { WorkProductDetail } from "./types.js";

export type { WorkProductDetail };

const SQL = /* sql */ `
SELECT
  wp.id, wp.task_id, wp.agent_id, wp.type, wp.title, wp.summary, wp.body,
  wp.url, wp.metadata, wp.provider, wp.external_id, wp.created_at, wp.updated_at,
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
  metadata: Record<string, unknown> | null;
  provider: string | null;
  external_id: string | null;
  created_at: Date;
  updated_at: Date;
  task_title: string;
  agent_label: string;
}

const MAX_BODY_BYTES = 256 * 1024;

function truncateToMax(body: string | null | undefined): string | undefined {
  if (!body) return undefined;
  if (Buffer.byteLength(body, "utf-8") <= MAX_BODY_BYTES) return body;
  const buf = Buffer.from(body, "utf-8");
  return buf.subarray(0, MAX_BODY_BYTES).toString("utf-8") + "\n\n[truncated]";
}

/** Hard cap on artifact file size we'll buffer into memory. */
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

async function readBoundedFile(path: string): Promise<string | undefined> {
  try {
    // stat first so a malicious or oversized artifact doesn't ballon
    // Express memory; truncate the on-disk content rather than refusing.
    const info = await stat(path);
    const buf = await readFile(path);
    const text = buf
      .subarray(0, Math.min(info.size, MAX_ARTIFACT_BYTES))
      .toString("utf-8");
    return truncateToMax(text);
  } catch {
    return undefined;
  }
}

async function tryReadFileUrl(url: string): Promise<string | undefined> {
  if (!url.startsWith("file://")) return undefined;
  return readBoundedFile(fileURLToPath(url));
}

/**
 * Sandbox artifacts store the host filesystem path in
 * `metadata.host_path`, not in `url`. Older rows pre-date the file://
 * url shim added in /runtime/done; fall back to metadata so the body
 * still inlines.
 */
async function tryReadHostPath(
  metadata: Record<string, unknown> | null,
): Promise<string | undefined> {
  if (!metadata) return undefined;
  const hp = metadata.host_path;
  if (typeof hp !== "string" || hp === "") return undefined;
  return readBoundedFile(hp);
}

/**
 * Resolve an artifact work_product's body content. Single source of
 * truth for `body → file://url → metadata.host_path` resolution —
 * used by both `getWorkProduct` (work-product detail page) and the
 * `learned-skills` SKILL.md writer.
 */
export async function readArtifactBody(wp: {
  body?: string | null;
  url?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<string | undefined> {
  const direct = truncateToMax(wp.body);
  if (direct) return direct;
  if (wp.url && wp.url.startsWith("file://")) {
    const fromUrl = await tryReadFileUrl(wp.url);
    if (fromUrl) return fromUrl;
  }
  return tryReadHostPath(wp.metadata ?? null);
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
  const body = await readArtifactBody({ body: row.body, url, metadata: row.metadata });

  return {
    id: row.id,
    task_id: row.task_id,
    task_short_id: deriveShortId(row.task_id),
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
