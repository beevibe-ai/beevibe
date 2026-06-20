import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateAdrVisualReport,
  renderAdrVisualMarkdown,
} from "./adr-visual-report.js";

let workdir: string;

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "adr-visual-report-test-"));
});

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(path.join(workdir, file), `${JSON.stringify(value, null, 2)}\n`);
}

describe("generateAdrVisualReport", () => {
  it("distills ADR artifacts into visual report primitives", async () => {
    await writeJson("architecture.spec.json", {
      decision: {
        id: "auth_provider",
        title: "Auth Provider",
        status: "proposed",
        mode: "decision",
        selected_topology: "better_auth",
        recommendation: "better_auth",
        summary: "Pick a provider.",
        ranked_options: [{ name: "better_auth" }],
      },
      evidence_summary: {
        better_auth: { risks: ["Young ecosystem."] },
      },
      evidence: [
        { source_type: "mature_oss", score: 0.8 },
        { source_type: "engineering_writeup", score: 0.6 },
      ],
    });
    await writeJson("comparison-matrix.json", {
      axes: [
        { id: "production_examples", label: "Production examples" },
        {
          id: "query_shape_password_login",
          label: "Query shape: password login",
          rationale: "Supports password login.",
        },
      ],
      candidates: [{ name: "better_auth", label: "Better Auth" }],
    });
    await writeJson("knowledge-map.json", {
      promoted_candidates: [
        {
          name: "better_auth",
          label: "Better Auth",
          promotion_status: "promoted",
          evidence_count: 2,
          score: 1.4,
          citations: [1, 2],
          support: [{ claim: "fast" }],
          warnings: [],
          rejections: [],
        },
      ],
      insufficient_evidence_candidates: [],
    });
    await writeJson("state.json", {
      evidence_count: 2,
      promoted_candidate_count: 1,
      comparison_matrix_empty_cells: 1,
      estimated_usd: 0.1234,
    });

    const report = await generateAdrVisualReport({
      runDir: workdir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(report.decision.title).toBe("Auth Provider");
    expect(report.candidates[0]).toMatchObject({
      id: "better_auth",
      label: "Better Auth",
      status: "promoted",
      evidenceCount: 2,
      supportCount: 1,
    });
    expect(report.evidenceMix).toEqual([
      { sourceType: "mature_oss", count: 1, averageScore: 0.8 },
      { sourceType: "engineering_writeup", count: 1, averageScore: 0.6 },
    ]);
    expect(report.matrixCoverage).toMatchObject({
      axes: 2,
      candidates: 1,
      totalCells: 2,
      emptyCells: 1,
      filledCells: 1,
      coveragePercent: 50,
    });
    expect(report.queryShapes).toHaveLength(1);
    expect(report.riskSignals).toEqual([
      { topic: "Better Auth", risk: "Young ecosystem." },
    ]);
    expect(report.mermaid.decisionFunnel).toContain("flowchart LR");
  });

  it("writes json and markdown outputs when paths are provided", async () => {
    await writeJson("architecture.spec.json", {
      decision: { id: "x", title: "X", ranked_options: [] },
      evidence: [],
    });
    await writeJson("comparison-matrix.json", { axes: [], candidates: [] });

    const outputJsonPath = path.join(workdir, "visual-report.json");
    const outputMarkdownPath = path.join(workdir, "visual-report.md");

    await generateAdrVisualReport({
      runDir: workdir,
      outputJsonPath,
      outputMarkdownPath,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(JSON.parse(await fs.readFile(outputJsonPath, "utf-8")).version).toBe(
      "0.1.0",
    );
    expect(await fs.readFile(outputMarkdownPath, "utf-8")).toContain(
      "## Decision Funnel",
    );
  });
});

describe("renderAdrVisualMarkdown", () => {
  it("renders mermaid blocks", () => {
    const markdown = renderAdrVisualMarkdown({
      version: "0.1.0",
      generatedAt: "2026-05-26T00:00:00.000Z",
      sourceRun: "demo",
      decision: {
        id: "demo",
        title: "Demo",
        status: "proposed",
        mode: "decision",
        selectedTopology: null,
        recommendation: null,
        summary: "",
      },
      kpis: [],
      candidates: [],
      evidenceMix: [],
      decisionFunnel: [],
      matrixCoverage: {
        axes: 0,
        candidates: 0,
        totalCells: 0,
        emptyCells: 0,
        filledCells: 0,
        coveragePercent: 0,
      },
      queryShapes: [],
      riskSignals: [],
      mermaid: { decisionFunnel: "flowchart LR", evidenceMix: "pie showData" },
    });

    expect(markdown).toContain("```mermaid\nflowchart LR\n```");
    expect(markdown).toContain("```mermaid\npie showData\n```");
  });
});
