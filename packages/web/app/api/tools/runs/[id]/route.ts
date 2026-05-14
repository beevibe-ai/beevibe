/**
 * Poll endpoint for an in-flight or completed sandboxed tool run.
 * Returns the full RunState — transcript + artifact metadata.
 *
 * GET /api/tools/runs/[id]
 */
import { NextResponse } from "next/server";
import { getRun } from "@/lib/tools/run-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const state = getRun(params.id);
  if (!state) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // Don't ship host_path to clients (filesystem leak); replace with a
  // public artifact route the UI can fetch.
  const artifacts = state.artifacts.map((a) => ({
    filename: a.filename,
    title: a.title,
    size_bytes: a.size_bytes,
    sandbox_path: a.sandbox_path,
    href: `/api/tools/runs/${state.run_id}/artifacts/${encodeURIComponent(a.filename)}`,
  }));
  return NextResponse.json({ ...state, artifacts });
}
