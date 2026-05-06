/**
 * Mesh tool assembly tests — IC vs team tier gating.
 *
 * Per-tool handler behavior is covered indirectly by the m6/m7 e2e scripts
 * (mesh flows require live Postgres + spawned CLI subprocesses). This file
 * locks the static tier inventory so future skill-loader work can rely on
 * the tool counts being stable.
 */
import { describe, expect, it } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import { buildIcMeshTools, buildTeamMeshTools, type MeshToolServices } from "./mesh.js";

// Fake services — the assembly itself doesn't invoke handlers, so the
// dependencies just need to be the right shape.
const fakeServices = {} as unknown as MeshToolServices;

const fakeCaller: ResolvedCaller = {
  agentId: "agent_x",
  source: "agent",
  hierarchyLevel: "team",
};
const fakeCtx = { caller: fakeCaller, beevibeSid: "ses_x" };

describe("buildIcMeshTools (M9.1)", () => {
  it("returns exactly 2 tools: respond_ask + report_blocker", () => {
    const tools = buildIcMeshTools(fakeCtx, fakeServices);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["report_blocker", "respond_ask"]);
  });

  it("does NOT include respond_negotiate (M9.1 dropped it; ICs are workers, not deciders)", () => {
    const tools = buildIcMeshTools(fakeCtx, fakeServices);
    expect(tools.some((t) => t.name === "respond_negotiate")).toBe(false);
  });

  it("does NOT include any initiator-side tools", () => {
    const tools = buildIcMeshTools(fakeCtx, fakeServices);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("ask");
    expect(names).not.toContain("negotiate");
    expect(names).not.toContain("escalate_to_humans");
  });
});

describe("buildTeamMeshTools", () => {
  it("returns exactly 6 tools (full mesh surface)", () => {
    const tools = buildTeamMeshTools(fakeCtx, fakeServices);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "ask",
      "escalate_to_humans",
      "negotiate",
      "report_blocker",
      "respond_ask",
      "respond_negotiate",
    ]);
  });
});
