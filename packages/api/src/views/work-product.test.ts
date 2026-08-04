/**
 * Tests for views/work-product.ts — the row → DTO mapping and, more
 * importantly, `readArtifactBody`'s three-step resolution chain
 * (`body` column → `file://` url → `metadata.host_path`) plus the
 * 256 KB truncation cap.
 *
 * The file:// / host_path cases need real files, so each writes into a
 * per-suite temp dir rather than mocking node:fs — the code under test
 * `stat`s before reading and we want that path exercised for real.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkProduct, readArtifactBody } from "./work-product.js";
import { makeMockPool } from "./test-helpers.js";

const MAX_BODY_BYTES = 256 * 1024;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "beevibe-wp-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function tempFile(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, "utf-8");
  return path;
}

const baseRow = {
  id: "wp_abc123def",
  task_id: "tsk_998877ff",
  agent_id: "agt_5150",
  type: "document" as const,
  title: "Auth migration plan",
  summary: null,
  body: null,
  url: null,
  metadata: null,
  provider: null,
  external_id: null,
  created_at: new Date("2026-04-30T10:00:00Z"),
  updated_at: new Date("2026-05-01T11:30:00Z"),
  task_title: "Migrate auth",
  agent_label: "Alice",
};

describe("readArtifactBody", () => {
  it("prefers the body column and never touches the filesystem", async () => {
    const body = await readArtifactBody({
      body: "from the column",
      url: "file:///definitely/does/not/exist.md",
      metadata: { host_path: "/also/missing" },
    });
    expect(body).toBe("from the column");
  });

  it("returns undefined when there is no body, url, or metadata", async () => {
    await expect(readArtifactBody({})).resolves.toBeUndefined();
    await expect(
      readArtifactBody({ body: null, url: null, metadata: null }),
    ).resolves.toBeUndefined();
  });

  it("treats an empty body column as absent and falls through to the url", async () => {
    const path = await tempFile("empty-fallthrough.md", "from the file");
    const body = await readArtifactBody({
      body: "",
      url: pathToFileURL(path).href,
    });
    expect(body).toBe("from the file");
  });

  it("reads a file:// url when the body column is empty", async () => {
    const path = await tempFile("from-url.md", "# Plan\n\nstep one");
    const body = await readArtifactBody({ url: pathToFileURL(path).href });
    expect(body).toBe("# Plan\n\nstep one");
  });

  it("ignores non-file:// urls rather than trying to fetch them", async () => {
    const body = await readArtifactBody({
      url: "https://example.com/doc.md",
      metadata: null,
    });
    expect(body).toBeUndefined();
  });

  it("falls back to metadata.host_path when the file:// url is missing on disk", async () => {
    const path = await tempFile("host-path-fallback.md", "sandbox artifact");
    const body = await readArtifactBody({
      url: pathToFileURL(join(dir, "gone.md")).href,
      metadata: { host_path: path },
    });
    expect(body).toBe("sandbox artifact");
  });

  it("reads metadata.host_path when there is no url at all", async () => {
    const path = await tempFile("host-path-only.md", "sandbox only");
    const body = await readArtifactBody({ metadata: { host_path: path } });
    expect(body).toBe("sandbox only");
  });

  it("ignores a host_path that is absent, empty, or not a string", async () => {
    await expect(readArtifactBody({ metadata: {} })).resolves.toBeUndefined();
    await expect(
      readArtifactBody({ metadata: { host_path: "" } }),
    ).resolves.toBeUndefined();
    await expect(
      readArtifactBody({ metadata: { host_path: 42 } }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when neither the url nor the host_path exists", async () => {
    const body = await readArtifactBody({
      url: pathToFileURL(join(dir, "nope-a.md")).href,
      metadata: { host_path: join(dir, "nope-b.md") },
    });
    expect(body).toBeUndefined();
  });

  it("passes a body exactly at the 256 KB cap through untouched", async () => {
    const exact = "x".repeat(MAX_BODY_BYTES);
    const body = await readArtifactBody({ body: exact });
    expect(body).toBe(exact);
    expect(body).not.toContain("[truncated]");
  });

  it("truncates an over-cap body and marks it", async () => {
    const body = await readArtifactBody({ body: "y".repeat(MAX_BODY_BYTES + 1_000) });
    expect(body).toBe("y".repeat(MAX_BODY_BYTES) + "\n\n[truncated]");
  });

  it("truncates an over-cap file body too", async () => {
    const path = await tempFile("huge.md", "z".repeat(MAX_BODY_BYTES + 500));
    const body = await readArtifactBody({ url: pathToFileURL(path).href });
    expect(body?.endsWith("\n\n[truncated]")).toBe(true);
    expect(body?.startsWith("z".repeat(1_000))).toBe(true);
  });
});

describe("getWorkProduct", () => {
  it("queries by id and returns undefined when the row is missing", async () => {
    const pool = makeMockPool([]);
    await expect(getWorkProduct(pool, "wp_missing")).resolves.toBeUndefined();
    expect(pool._spy).toHaveBeenCalledWith(expect.any(String), ["wp_missing"]);
  });

  it("maps a minimal row, omitting every optional field", async () => {
    const pool = makeMockPool([baseRow]);
    const wp = await getWorkProduct(pool, "wp_abc123def");
    expect(wp).toEqual({
      id: "wp_abc123def",
      task_id: "tsk_998877ff",
      task_short_id: "998877",
      task_title: "Migrate auth",
      agent_id: "agt_5150",
      agent_label: "Alice",
      type: "document",
      title: "Auth migration plan",
      url_is_local: false,
      created_at: "2026-04-30T10:00:00.000Z",
      updated_at: "2026-05-01T11:30:00.000Z",
    });
    // Optional keys are omitted, not set to undefined.
    expect(Object.keys(wp!)).not.toContain("summary");
    expect(Object.keys(wp!)).not.toContain("body");
    expect(Object.keys(wp!)).not.toContain("url");
  });

  it("includes the optional fields when the row carries them", async () => {
    const pool = makeMockPool([
      {
        ...baseRow,
        summary: "one paragraph",
        body: "full content",
        url: "https://example.com/wp",
        provider: "github",
        external_id: "PR-42",
      },
    ]);
    const wp = await getWorkProduct(pool, "wp_abc123def");
    expect(wp).toMatchObject({
      summary: "one paragraph",
      body: "full content",
      url: "https://example.com/wp",
      provider: "github",
      external_id: "PR-42",
      url_is_local: false,
    });
  });

  it("flags url_is_local and inlines the body for a file:// url", async () => {
    const path = await tempFile("detail.md", "on-disk deliverable");
    const pool = makeMockPool([{ ...baseRow, url: pathToFileURL(path).href }]);
    const wp = await getWorkProduct(pool, "wp_abc123def");
    expect(wp?.url_is_local).toBe(true);
    expect(wp?.body).toBe("on-disk deliverable");
  });

  it("keeps url_is_local false for an http url", async () => {
    const pool = makeMockPool([{ ...baseRow, url: "https://example.com/doc" }]);
    const wp = await getWorkProduct(pool, "wp_abc123def");
    expect(wp?.url_is_local).toBe(false);
  });

  it("resolves the body from metadata.host_path when the column is empty", async () => {
    const path = await tempFile("detail-host.md", "sandbox deliverable");
    const pool = makeMockPool([{ ...baseRow, metadata: { host_path: path } }]);
    const wp = await getWorkProduct(pool, "wp_abc123def");
    expect(wp?.body).toBe("sandbox deliverable");
  });

  it("omits body when the file:// url points at nothing", async () => {
    const pool = makeMockPool([
      { ...baseRow, url: pathToFileURL(join(dir, "vanished.md")).href },
    ]);
    const wp = await getWorkProduct(pool, "wp_abc123def");
    expect(wp?.url_is_local).toBe(true);
    expect(Object.keys(wp!)).not.toContain("body");
  });
});
