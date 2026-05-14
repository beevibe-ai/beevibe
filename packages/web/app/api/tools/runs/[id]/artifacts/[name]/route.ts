/**
 * Serve a single artifact file from a completed run.
 *
 * GET /api/tools/runs/[id]/artifacts/[name]
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { NextResponse } from "next/server";
import { getRun } from "@/lib/tools/run-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
};

export async function GET(
  _request: Request,
  { params }: { params: { id: string; name: string } },
): Promise<NextResponse> {
  const state = getRun(params.id);
  if (!state) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const decoded = decodeURIComponent(params.name);
  const meta = state.artifacts.find((a) => a.filename === decoded);
  if (!meta) {
    return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
  }
  try {
    const data = await readFile(meta.host_path);
    const mime = MIME[extname(meta.filename).toLowerCase()] ?? "application/octet-stream";
    return new NextResponse(data, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `inline; filename="${meta.filename}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }
}
