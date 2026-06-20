/**
 * Build visual-report artifacts from an ADR run directory.
 *
 * The ADR runner already emits rich structured files (`architecture.spec.json`,
 * `comparison-matrix.json`, `knowledge-map.json`, `state.json`, `evidence.json`).
 * This script distills those into a compact visual contract that web/newsletter
 * surfaces can render without re-learning every ADR internal file shape.
 *
 * Usage:
 *   pnpm adr:visual .adr-runs/retrieval-architecture-v3
 *   pnpm adr:visual .adr-runs/foo --json out.json --md out.md
 */

import { promises as fs } from "node:fs";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

export interface AdrVisualKpi {
  id: string;
  label: string;
  value: string;
  tone: "neutral" | "good" | "warning" | "critical";
}

export interface AdrVisualCandidate {
  id: string;
  label: string;
  status: string;
  score: number;
  evidenceCount: number;
  supportCount: number;
  warningCount: number;
  rejectionCount: number;
  citations: number[];
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

export interface AdrQueryShape {
  id: string;
  label: string;
  rationale: string;
}

export interface AdrVisualReport {
  version: "0.1.0";
  generatedAt: string;
  sourceRun: string;
  decision: {
    id: string;
    title: string;
    status: string;
    mode: string;
    selectedTopology: string | null;
    recommendation: string | null;
    summary: string;
  };
  kpis: AdrVisualKpi[];
  candidates: AdrVisualCandidate[];
  evidenceMix: AdrEvidenceMixEntry[];
  decisionFunnel: AdrFunnelStep[];
  matrixCoverage: {
    axes: number;
    candidates: number;
    totalCells: number;
    emptyCells: number;
    filledCells: number;
    coveragePercent: number;
  };
  queryShapes: AdrQueryShape[];
  riskSignals: AdrRiskSignal[];
  mermaid: {
    decisionFunnel: string;
    evidenceMix: string;
  };
}

export interface GenerateAdrVisualReportOptions {
  runDir: string;
  outputJsonPath?: string;
  outputMarkdownPath?: string;
  generatedAt?: string;
}

async function readJsonFile(runDir: string, file: string): Promise<unknown> {
  const raw = await fs.readFile(path.join(runDir, file), "utf-8");
  return JSON.parse(raw) as unknown;
}

async function readOptionalJson(runDir: string, file: string): Promise<unknown | undefined> {
  try {
    return await readJsonFile(runDir, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw err;
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toTitle(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function collectCandidates(
  knowledgeMap: JsonRecord,
  comparisonMatrix: JsonRecord,
): AdrVisualCandidate[] {
  const fromKnowledge = [
    ...asArray(knowledgeMap.promoted_candidates),
    ...asArray(knowledgeMap.insufficient_evidence_candidates),
  ].map(asRecord);

  const byId = new Map<string, AdrVisualCandidate>();
  for (const candidate of fromKnowledge) {
    const id = asString(candidate.name);
    if (!id) continue;
    byId.set(id, {
      id,
      label: asString(candidate.label, toTitle(id)),
      status: asString(candidate.promotion_status, "unknown"),
      score: asNumber(candidate.score),
      evidenceCount: asNumber(candidate.evidence_count),
      supportCount: asArray(candidate.support).length,
      warningCount: asArray(candidate.warnings).length,
      rejectionCount: asArray(candidate.rejections).length,
      citations: asArray(candidate.citations).filter((v): v is number => typeof v === "number"),
    });
  }

  for (const candidate of asArray(comparisonMatrix.candidates).map(asRecord)) {
    const id = asString(candidate.name);
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      label: asString(candidate.label, toTitle(id)),
      status: asString(candidate.promotion_status, "unknown"),
      score: asNumber(candidate.score),
      evidenceCount: asNumber(candidate.evidence_count),
      supportCount: 0,
      warningCount: 0,
      rejectionCount: 0,
      citations: asArray(candidate.citations).filter((v): v is number => typeof v === "number"),
    });
  }

  return [...byId.values()].sort((a, b) => b.score - a.score);
}

function collectEvidenceMix(evidenceItems: unknown[]): AdrEvidenceMixEntry[] {
  const buckets = new Map<string, { count: number; scoreTotal: number }>();
  for (const item of evidenceItems.map(asRecord)) {
    const sourceType = asString(item.source_type, "unknown");
    const current = buckets.get(sourceType) ?? { count: 0, scoreTotal: 0 };
    current.count += 1;
    current.scoreTotal += asNumber(item.score);
    buckets.set(sourceType, current);
  }
  return [...buckets.entries()]
    .map(([sourceType, bucket]) => ({
      sourceType,
      count: bucket.count,
      averageScore:
        bucket.count > 0 ? Number((bucket.scoreTotal / bucket.count).toFixed(3)) : 0,
    }))
    .sort((a, b) => b.count - a.count || b.averageScore - a.averageScore);
}

function collectRisks(architectureSpec: JsonRecord): AdrRiskSignal[] {
  const evidenceSummary = asRecord(architectureSpec.evidence_summary);
  const risks: AdrRiskSignal[] = [];
  for (const [topic, summary] of Object.entries(evidenceSummary)) {
    const summaryRecord = asRecord(summary);
    for (const risk of asArray(summaryRecord.risks)) {
      if (typeof risk === "string" && risk.trim()) {
        risks.push({ topic: toTitle(topic), risk: risk.trim() });
      }
    }
  }
  return risks.slice(0, 12);
}

function collectQueryShapes(comparisonMatrix: JsonRecord): AdrQueryShape[] {
  return asArray(comparisonMatrix.axes)
    .map(asRecord)
    .filter((axis) => asString(axis.id).startsWith("query_shape_"))
    .map((axis) => ({
      id: asString(axis.id),
      label: asString(axis.label, toTitle(asString(axis.id))),
      rationale: asString(axis.rationale),
    }));
}

function buildDecisionFunnel(
  candidates: AdrVisualCandidate[],
  architectureSpec: JsonRecord,
  knowledgeMap: JsonRecord,
): AdrFunnelStep[] {
  const decision = asRecord(architectureSpec.decision);
  return [
    { label: "Candidates", count: candidates.length },
    {
      label: "Evidence-backed",
      count: candidates.filter((candidate) => candidate.evidenceCount > 0).length,
    },
    {
      label: "Promoted",
      count: asArray(knowledgeMap.promoted_candidates).length,
    },
    {
      label: "Ranked",
      count: asArray(decision.ranked_options).length,
    },
    {
      label: "Recommended",
      count: asString(decision.recommendation) ? 1 : 0,
    },
  ];
}

function buildMermaidFunnel(steps: AdrFunnelStep[]): string {
  const lines = ["flowchart LR"];
  steps.forEach((step, index) => {
    const nodeId = `S${index}`;
    const label = `${step.label}: ${step.count}`.replace(/"/g, "'");
    lines.push(`  ${nodeId}["${label}"]`);
    if (index > 0) lines.push(`  S${index - 1} --> ${nodeId}`);
  });
  return lines.join("\n");
}

function buildMermaidEvidenceMix(entries: AdrEvidenceMixEntry[]): string {
  const lines = ["pie showData", '  title Evidence mix'];
  if (entries.length === 0) {
    lines.push('  "none" : 1');
    return lines.join("\n");
  }
  for (const entry of entries) {
    const label = entry.sourceType.replace(/"/g, "'");
    lines.push(`  "${label}" : ${entry.count}`);
  }
  return lines.join("\n");
}

export async function generateAdrVisualReport(
  opts: GenerateAdrVisualReportOptions,
): Promise<AdrVisualReport> {
  const runDir = path.resolve(opts.runDir);
  const [architectureRaw, matrixRaw, knowledgeRaw, stateRaw, evidenceRaw] =
    await Promise.all([
      readJsonFile(runDir, "architecture.spec.json"),
      readJsonFile(runDir, "comparison-matrix.json"),
      readOptionalJson(runDir, "knowledge-map.json"),
      readOptionalJson(runDir, "state.json"),
      readOptionalJson(runDir, "evidence.json"),
    ]);

  const architectureSpec = asRecord(architectureRaw);
  const comparisonMatrix = asRecord(matrixRaw);
  const knowledgeMap = asRecord(knowledgeRaw);
  const state = asRecord(stateRaw);
  const decision = asRecord(architectureSpec.decision);
  const candidates = collectCandidates(knowledgeMap, comparisonMatrix);
  const evidenceItems = asArray(evidenceRaw ?? architectureSpec.evidence);
  const evidenceMix = collectEvidenceMix(evidenceItems);
  const decisionFunnel = buildDecisionFunnel(candidates, architectureSpec, knowledgeMap);

  const axes = asArray(comparisonMatrix.axes).length;
  const candidateCount = asArray(comparisonMatrix.candidates).length || candidates.length;
  const totalCells = axes * candidateCount;
  const emptyCells = Math.min(
    totalCells,
    asNumber(state.comparison_matrix_empty_cells, totalCells > 0 ? totalCells : 0),
  );
  const filledCells = Math.max(0, totalCells - emptyCells);
  const coveragePercent =
    totalCells > 0 ? clampPercent((filledCells / totalCells) * 100) : 0;

  const report: AdrVisualReport = {
    version: "0.1.0",
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    sourceRun: path.basename(runDir),
    decision: {
      id: asString(decision.id, "unknown_decision"),
      title: asString(decision.title, "Untitled ADR"),
      status: asString(decision.status, "unknown"),
      mode: asString(decision.mode, asString(state.decision_mode, "unknown")),
      selectedTopology: asString(decision.selected_topology) || null,
      recommendation: asString(decision.recommendation) || null,
      summary: asString(decision.summary),
    },
    kpis: [
      {
        id: "evidence_count",
        label: "Evidence",
        value: String(evidenceItems.length || asNumber(state.evidence_count)),
        tone: "neutral",
      },
      {
        id: "promoted",
        label: "Promoted",
        value: String(asNumber(state.promoted_candidate_count)),
        tone: asNumber(state.promoted_candidate_count) > 0 ? "good" : "warning",
      },
      {
        id: "matrix_coverage",
        label: "Matrix coverage",
        value: `${coveragePercent}%`,
        tone:
          coveragePercent >= 70 ? "good" : coveragePercent >= 35 ? "warning" : "critical",
      },
      {
        id: "estimated_cost",
        label: "Run cost",
        value: `$${asNumber(state.estimated_usd).toFixed(3)}`,
        tone: "neutral",
      },
    ],
    candidates,
    evidenceMix,
    decisionFunnel,
    matrixCoverage: {
      axes,
      candidates: candidateCount,
      totalCells,
      emptyCells,
      filledCells,
      coveragePercent,
    },
    queryShapes: collectQueryShapes(comparisonMatrix),
    riskSignals: collectRisks(architectureSpec),
    mermaid: {
      decisionFunnel: buildMermaidFunnel(decisionFunnel),
      evidenceMix: buildMermaidEvidenceMix(evidenceMix),
    },
  };

  if (opts.outputJsonPath) {
    await fs.writeFile(opts.outputJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (opts.outputMarkdownPath) {
    await fs.writeFile(opts.outputMarkdownPath, renderAdrVisualMarkdown(report));
  }

  return report;
}

export function renderAdrVisualMarkdown(report: AdrVisualReport): string {
  const candidateRows = report.candidates
    .slice(0, 10)
    .map(
      (candidate) =>
        `| ${candidate.label} | ${candidate.status} | ${candidate.score.toFixed(3)} | ${candidate.evidenceCount} | ${candidate.supportCount}/${candidate.warningCount}/${candidate.rejectionCount} |`,
    )
    .join("\n");
  const riskRows =
    report.riskSignals.length > 0
      ? report.riskSignals
          .map((risk) => `- **${risk.topic}:** ${risk.risk}`)
          .join("\n")
      : "- No risk signals extracted.";

  return `# ${report.decision.title} - Visual Report

Source run: \`${report.sourceRun}\`

Status: **${report.decision.status}**  
Mode: **${report.decision.mode}**  
Selected topology: **${report.decision.selectedTopology ?? "none"}**

## Decision Funnel

\`\`\`mermaid
${report.mermaid.decisionFunnel}
\`\`\`

## Evidence Mix

\`\`\`mermaid
${report.mermaid.evidenceMix}
\`\`\`

## KPI Strip

${report.kpis.map((kpi) => `- **${kpi.label}:** ${kpi.value}`).join("\n")}

## Candidate Scorecards

| Candidate | Status | Score | Evidence | Support/Warnings/Rejections |
| --- | --- | ---: | ---: | ---: |
${candidateRows || "| No candidates | - | 0 | 0 | 0/0/0 |"}

## Matrix Coverage

- Axes: ${report.matrixCoverage.axes}
- Candidates: ${report.matrixCoverage.candidates}
- Filled cells: ${report.matrixCoverage.filledCells}/${report.matrixCoverage.totalCells}
- Coverage: ${report.matrixCoverage.coveragePercent}%

## Risk Signals

${riskRows}
`;
}

function parseArgs(argv: string[]): {
  runDir: string;
  outputJsonPath?: string;
  outputMarkdownPath?: string;
  stdout: boolean;
} {
  const args = [...argv];
  const runDir = args.shift();
  if (!runDir || runDir.startsWith("--")) {
    throw new Error("Usage: pnpm adr:visual <run-dir> [--json path] [--md path] [--stdout]");
  }
  let outputJsonPath: string | undefined;
  let outputMarkdownPath: string | undefined;
  let stdout = false;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--json") outputJsonPath = args.shift();
    else if (arg === "--md") outputMarkdownPath = args.shift();
    else if (arg === "--stdout") stdout = true;
    else throw new Error(`Unknown argument: ${arg ?? ""}`);
  }
  return { runDir, outputJsonPath, outputMarkdownPath, stdout };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { runDir, outputJsonPath, outputMarkdownPath, stdout } = parseArgs(
    process.argv.slice(2),
  );
  const resolvedRunDir = path.resolve(runDir);
  const resolvedOutputJsonPath =
    outputJsonPath ?? path.join(resolvedRunDir, "visual-report.json");
  const resolvedOutputMarkdownPath =
    outputMarkdownPath ?? path.join(resolvedRunDir, "visual-report.md");
  generateAdrVisualReport({
    runDir: resolvedRunDir,
    outputJsonPath: resolvedOutputJsonPath,
    outputMarkdownPath: resolvedOutputMarkdownPath,
  })
    .then((report) => {
      if (stdout) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`visual report: ${resolvedOutputJsonPath}`);
        console.log(`markdown brief: ${resolvedOutputMarkdownPath}`);
      }
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
