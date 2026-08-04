/**
 * Tests for views/work-product.ts.
 *
 * Two things worth pinning down here. The row → DTO mapping is the
 * usual view-layer shape (optional fields omitted rather than set to
 * null), but `readArtifactBody` is the interesting half: it's the
 * single source of truth for the `body → file:// url → metadata
 * .host_path` fallback chain shared with the learned-skills SKILL.md
 * writer, and each rung has to be reachable independently. Those cases
 * use real temp files rather than an fs mock so the URL→path
 * conversion and the size bounding are exercised for real.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getWorkProduct, readArtifactBody } from "./work-product.js";
import { makeMockPool } from "./test-helpers.js";

let dir: string;
let artifactPath: string;
let artifactUrl: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bv-wp-"));
  artifactPath = join(dir, "report.md");
  await writeFile(artifactPath, "# On-disk report\n", "utf-8");
  artifactUrl = pathToFileURL(artifactPath).href;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const baseRow = {
  id: "wp_abc123def",
  task_id: "task_xyz789",
  agent_id: "agt_writer1",
  type: "document" as const,
  title: "Launch playbook",
  summary: "Two-week rollout plan",
  body: "The playbook body.",
  url: "https://example.com/doc",
  metadata: null,
  provider: "notion",
  external_id: "notion_1",
  created_at: new Date("2026-05-04T10:00:00Z"),
  updated_at: new Date("2026-05-04T11:00:00Z"),
  task_title: "Ship the launch",
  agent_label: "Comms specialist",
};

describe("getWorkProduct", () => {
  it("forwards the id to the SQL", async () => {
    const pool = makeMockPool([baseRow]);
    await getWorkProduct(pool, "wp_abc123def");
    expect(pool._spy).toHaveBeenCalledWith(expect.any(String), ["wp_abc123def"]);
  });

  it("returns undefined when no row matches", async () => {
    const pool = makeMockPool([]);
    expect(await getWorkProduct(pool, "wp_missing")).toBeUndefined();
  });

  it("maps a full row, deriving the task short id and ISO timestamps", async () => {
    const pool = makeMockPool([baseRow]);
    const wp = await getWorkProduct(pool, "wp_abc123def");
    expect(wp).toEqual({
      id: "wp_abc123def",
      task_id: "task_xyz789",
      task_short_id: "xyz789",
      task_title: "Ship the launch",
      agent_id: "agt_writer1",
      agent_label: "Comms specialist",
      type: "document",
      title: "Launch playbook",
      summary: "Two-week rollout plan",
      url: "https://example.com/doc",
      provider: "notion",
      external_id: "notion_1",
      body: "The playbook body.",
      url_is_local: false,
      created_at: "2026-05-04T10:00:00.000Z",
      updated_at: "2026-05-04T11:00:00.000Z",
    });
  });

  it("omits optional fields rather than emitting nulls", async () => {
    const pool = makeMockPool([
      {
        ...baseRow,
        summary: null,
        body: null,
        url: null,
        provider: null,
        external_id: null,
      },
    ]);
    const wp = await getWorkProduct(pool, "wp_abc123def");
    expect(wp).toBeDefined();
    expect(Object.keys(wp!)).not.toContain("summary");
    expect(Object.keys(wp!)).not.toContain("url");
    expect(Object.keys(wp!)).not.toContain("provider");
    expect(Object.keys(wp!)).not.toContain("external_id");
    expect(Object.keys(wp!)).not.toContain("body");
    expect(wp!.url_is_local).toBe(false);
  });

  it("flags url_is_local and inlines the file body for a file:// url", async () => {
    const pool = makeMockPool([{ ...baseRow, body: null, url: artifactUrl }]);
    const wp = await getWorkProduct(pool, "wp_abc123def");
    expect(wp?.url_is_local).toBe(true);
    expect(wp?.body).toBe("# On-disk report\n");
  });
});

describe("readArtifactBody", () => {
  it("prefers the persisted body column over any file fallback", async () => {
    const body = await readArtifactBody({
      body: "from the column",
      url: artifactUrl,
      metadata: { host_path: artifactPath },
    });
    expect(body).toBe("from the column");
  });

  it("reads a file:// url when the body column is empty", async () => {
    expect(await readArtifactBody({ body: null, url: artifactUrl })).toBe(
      "# On-disk report\n",
    );
  });

  it("treats an empty-string body as absent and falls through", async () => {
    expect(await readArtifactBody({ body: "", url: artifactUrl })).toBe(
      "# On-disk report\n",
    );
  });

  it("ignores non-file:// urls", async () => {
    expect(
      await readArtifactBody({ body: null, url: "https://example.com/doc" }),
    ).toBeUndefined();
  });

  it("falls back to metadata.host_path when the file:// url is unreadable", async () => {
    const body = await readArtifactBody({
      body: null,
      url: pathToFileURL(join(dir, "gone.md")).href,
      metadata: { host_path: artifactPath },
    });
    expect(body).toBe("# On-disk report\n");
  });

  it("reads metadata.host_path for sandbox artifacts that carry no url", async () => {
    const body = await readArtifactBody({
      body: null,
      metadata: { host_path: artifactPath },
    });
    expect(body).toBe("# On-disk report\n");
  });

  it("returns undefined for a non-string or empty host_path", async () => {
    expect(await readArtifactBody({ metadata: { host_path: 42 } })).toBeUndefined();
    expect(await readArtifactBody({ metadata: { host_path: "" } })).toBeUndefined();
    expect(await readArtifactBody({ metadata: {} })).toBeUndefined();
    expect(await readArtifactBody({})).toBeUndefined();
  });

  it("returns undefined when the host_path file does not exist", async () => {
    const body = await readArtifactBody({
      metadata: { host_path: join(dir, "nope.md") },
    });
    expect(body).toBeUndefined();
  });

  it("truncates a body past the 256 KB cap and marks the cut", async () => {
    const oversized = "x".repeat(300 * 1024);
    const body = await readArtifactBody({ body: oversized });
    expect(body).toMatch(/\n\n\[truncated\]$/);
    expect(Buffer.byteLength(body!.replace(/\n\n\[truncated\]$/, ""))).toBe(
      256 * 1024,
    );
  });

  it("truncates an oversized on-disk artifact the same way", async () => {
    const big = join(dir, "big.txt");
    await writeFile(big, "y".repeat(300 * 1024), "utf-8");
    const body = await readArtifactBody({ metadata: { host_path: big } });
    expect(body).toMatch(/\n\n\[truncated\]$/);
  });
});
