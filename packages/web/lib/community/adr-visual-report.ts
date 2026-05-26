export interface AdrVisualKpi {
  id: string;
  label: string;
  value: string;
  tone: "neutral" | "good" | "warning" | "critical";
}

export interface AdrEvidenceMixEntry {
  sourceType: string;
  count: number;
  averageScore: number;
}

export interface AdrFunnelStep {
  label: string;
  count: number;
}

export interface AdrRiskSignal {
  topic: string;
  risk: string;
}

export interface AdrVisualReport {
  sourceRun: string;
  decision: {
    title: string;
    status: string;
    summary: string;
  };
  kpis: AdrVisualKpi[];
  evidenceMix: AdrEvidenceMixEntry[];
  decisionFunnel: AdrFunnelStep[];
  matrixCoverage: {
    axes: number;
    candidates: number;
    totalCells: number;
    filledCells: number;
    emptyCells: number;
    coveragePercent: number;
  };
  riskSignals: AdrRiskSignal[];
}

export const COMMUNITY_ADR_VISUAL_REPORT: AdrVisualReport = {
  sourceRun: "design-patterns-community-brief",
  decision: {
    title: "Building Patterns Index",
    status: "editorial",
    summary:
      "ADR-style curation compares the patterns behind shipped products, then turns the strongest lessons into reusable operating context for AI-native teams.",
  },
  kpis: [
    { id: "signals", label: "Signals reviewed", value: "64", tone: "neutral" },
    { id: "patterns", label: "Promoted patterns", value: "6", tone: "good" },
    { id: "coverage", label: "Matrix coverage", value: "83%", tone: "good" },
    { id: "operator_notes", label: "Operator notes", value: "18", tone: "neutral" },
  ],
  evidenceMix: [
    { sourceType: "product_artifacts", count: 18, averageScore: 0.91 },
    { sourceType: "engineering_writeups", count: 14, averageScore: 0.86 },
    { sourceType: "design_teardowns", count: 12, averageScore: 0.79 },
    { sourceType: "release_notes", count: 11, averageScore: 0.74 },
    { sourceType: "community_observations", count: 9, averageScore: 0.68 },
  ],
  decisionFunnel: [
    { label: "Signals", count: 64 },
    { label: "Candidates", count: 18 },
    { label: "Promoted", count: 6 },
    { label: "Compared", count: 6 },
    { label: "Operationalized", count: 3 },
  ],
  matrixCoverage: {
    axes: 5,
    candidates: 6,
    totalCells: 30,
    filledCells: 25,
    emptyCells: 5,
    coveragePercent: 83,
  },
  riskSignals: [
    {
      topic: "Transfer Risk",
      risk: "A visible product pattern can fail when copied without its surrounding operating rhythm.",
    },
    {
      topic: "Evidence Quality",
      risk: "Launch posts overstate intent; prefer artifacts, changelogs, docs, and workflow traces.",
    },
    {
      topic: "Agent Use",
      risk: "Patterns should become prompts, memory, checks, or tasks only after the tradeoff is explicit.",
    },
  ],
};
