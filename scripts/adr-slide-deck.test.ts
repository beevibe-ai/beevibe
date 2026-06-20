import { describe, expect, it } from "vitest";
import type { AdrVisualReport } from "./adr-visual-report.js";
import { renderAdrSlideDeckHtml } from "./adr-slide-deck.js";

function makeReport(): AdrVisualReport {
  return {
    version: "0.1.0",
    generatedAt: "2026-05-26T00:00:00.000Z",
    sourceRun: "demo",
    decision: {
      id: "demo",
      title: "Demo <ADR>",
      status: "proposed",
      mode: "decision",
      selectedTopology: "postgres",
      recommendation: "postgres",
      summary: "Summary <must be escaped>.",
    },
    kpis: [
      { id: "evidence", label: "Evidence", value: "12", tone: "neutral" },
      { id: "coverage", label: "Coverage", value: "90%", tone: "good" },
    ],
    candidates: [
      {
        id: "postgres",
        label: "Postgres",
        status: "promoted",
        score: 1.25,
        evidenceCount: 4,
        supportCount: 2,
        warningCount: 1,
        rejectionCount: 0,
        citations: [1, 2],
      },
    ],
    evidenceMix: [{ sourceType: "private_corpus", count: 4, averageScore: 0.7 }],
    decisionFunnel: [
      { label: "Candidates", count: 3 },
      { label: "Promoted", count: 1 },
    ],
    matrixCoverage: {
      axes: 2,
      candidates: 3,
      totalCells: 6,
      emptyCells: 1,
      filledCells: 5,
      coveragePercent: 83,
    },
    queryShapes: [],
    riskSignals: [{ topic: "Risk", risk: "Watch the edge case." }],
    mermaid: { decisionFunnel: "flowchart LR", evidenceMix: "pie showData" },
  };
}

describe("renderAdrSlideDeckHtml", () => {
  it("renders a fixed-stage deck and escapes report text", () => {
    const html = renderAdrSlideDeckHtml(makeReport());

    expect(html).toContain("width: 1920px");
    expect(html).toContain("height: 1080px");
    expect(html).toContain("class=\"deck-stage\"");
    expect(html).toContain("Demo &lt;ADR&gt;");
    expect(html).toContain("Summary &lt;must be escaped&gt;.");
    expect(html).not.toContain("Demo <ADR>");
  });

  it("includes visual report sections", () => {
    const html = renderAdrSlideDeckHtml(makeReport());

    expect(html).toContain("Decision funnel");
    expect(html).toContain("Evidence mix");
    expect(html).toContain("Candidate scorecards");
    expect(html).toContain("Coverage and risk");
    expect(html).toContain("Rendering contract");
  });
});
