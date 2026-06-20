/**
 * Render an ADR visual report as a zero-dependency HTML slide deck.
 *
 * This is Beevibe's technical rendering layer around the frontend-slides
 * workflow: ADR owns the evidence schema; this renderer owns the charts,
 * scorecards, and fixed 1920x1080 stage.
 *
 * Usage:
 *   pnpm adr:slides .adr-runs/retrieval-architecture-v3
 *   pnpm adr:slides .adr-runs/retrieval-architecture-v3/visual-report.json --out deck.html
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  generateAdrVisualReport,
  type AdrEvidenceMixEntry,
  type AdrFunnelStep,
  type AdrVisualCandidate,
  type AdrVisualReport,
} from "./adr-visual-report.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function pct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function topCandidates(report: AdrVisualReport): AdrVisualCandidate[] {
  return report.candidates.slice(0, 8);
}

function renderKpiStrip(report: AdrVisualReport): string {
  return report.kpis
    .map(
      (kpi) => `
        <div class="kpi tone-${escapeHtml(kpi.tone)}">
          <div class="kpi-label">${escapeHtml(kpi.label)}</div>
          <div class="kpi-value">${escapeHtml(kpi.value)}</div>
        </div>`,
    )
    .join("");
}

function renderFunnel(steps: AdrFunnelStep[]): string {
  const maxCount = Math.max(1, ...steps.map((step) => step.count));
  return steps
    .map((step, index) => {
      const width = pct((step.count / maxCount) * 100);
      return `
        <div class="funnel-row" style="--bar:${width}%">
          <div class="funnel-index">${String(index + 1).padStart(2, "0")}</div>
          <div class="funnel-label">${escapeHtml(step.label)}</div>
          <div class="funnel-track"><div></div></div>
          <div class="funnel-count">${escapeHtml(step.count)}</div>
        </div>`;
    })
    .join("");
}

function renderEvidenceMix(entries: AdrEvidenceMixEntry[]): string {
  const maxCount = Math.max(1, ...entries.map((entry) => entry.count));
  return entries
    .slice(0, 8)
    .map((entry) => {
      const width = pct((entry.count / maxCount) * 100);
      return `
        <div class="evidence-row" style="--bar:${width}%">
          <div class="evidence-label">${escapeHtml(entry.sourceType.replace(/_/g, " "))}</div>
          <div class="evidence-track"><div></div></div>
          <div class="evidence-score">${escapeHtml(entry.count)}</div>
        </div>`;
    })
    .join("");
}

function renderCandidateCards(candidates: AdrVisualCandidate[]): string {
  return candidates
    .slice(0, 6)
    .map(
      (candidate, index) => `
        <article class="candidate-card">
          <div class="candidate-rank">${String(index + 1).padStart(2, "0")}</div>
          <div>
            <h3>${escapeHtml(candidate.label)}</h3>
            <p>${escapeHtml(candidate.status.replace(/_/g, " "))}</p>
          </div>
          <div class="candidate-score">${escapeHtml(candidate.score.toFixed(2))}</div>
          <div class="candidate-meta">
            <span>${escapeHtml(candidate.evidenceCount)} evidence</span>
            <span>${escapeHtml(candidate.supportCount)} support</span>
            <span>${escapeHtml(candidate.rejectionCount)} reject</span>
          </div>
        </article>`,
    )
    .join("");
}

function renderCoverageGrid(report: AdrVisualReport): string {
  const cells = Math.min(80, Math.max(0, report.matrixCoverage.totalCells));
  const filled = Math.min(cells, Math.max(0, report.matrixCoverage.filledCells));
  return Array.from({ length: cells })
    .map((_, index) => `<span class="${index < filled ? "filled" : ""}"></span>`)
    .join("");
}

function renderRiskSignals(report: AdrVisualReport): string {
  return report.riskSignals
    .slice(0, 6)
    .map(
      (signal) => `
        <article class="risk-card">
          <h3>${escapeHtml(signal.topic)}</h3>
          <p>${escapeHtml(signal.risk)}</p>
        </article>`,
    )
    .join("");
}

export function renderAdrSlideDeckHtml(report: AdrVisualReport): string {
  const safeTitle = escapeHtml(report.decision.title);
  const candidates = topCandidates(report);
  const topCandidate = candidates[0];
  const statusLabel = report.decision.selectedTopology ?? report.decision.status;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} - ADR Deck</title>
  <link rel="preconnect" href="https://api.fontshare.com">
  <link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@500,700,800&f[]=sentient@400,500&display=swap">
  <style>
    :root {
      --stage-bg: #11110f;
      --slide-bg: #f7f0df;
      --ink: #181713;
      --muted: #6e675b;
      --paper: #fffaf0;
      --line: #28231a;
      --accent: #f6c945;
      --accent-2: #2f80ed;
      --accent-3: #29a06f;
      --danger: #db5c4b;
      --font-display: "Cabinet Grotesk", sans-serif;
      --font-serif: "Sentient", serif;
    }

    * { box-sizing: border-box; }

    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: var(--stage-bg, #000);
    }

    .deck-viewport {
      position: fixed;
      inset: 0;
      overflow: hidden;
      background:
        radial-gradient(circle at 12% 18%, rgba(246, 201, 69, 0.18), transparent 34%),
        radial-gradient(circle at 92% 84%, rgba(47, 128, 237, 0.16), transparent 34%),
        var(--stage-bg);
    }

    .deck-stage {
      position: absolute;
      left: 0;
      top: 0;
      width: 1920px;
      height: 1080px;
      overflow: hidden;
      transform-origin: 0 0;
      background: var(--slide-bg);
      box-shadow: 0 40px 110px rgba(0, 0, 0, 0.35);
    }

    .slide {
      position: absolute;
      inset: 0;
      width: 1920px;
      height: 1080px;
      overflow: hidden;
      display: block;
      visibility: hidden;
      opacity: 0;
      pointer-events: none;
      background:
        linear-gradient(90deg, rgba(24, 23, 19, 0.05) 1px, transparent 1px),
        linear-gradient(0deg, rgba(24, 23, 19, 0.04) 1px, transparent 1px),
        var(--slide-bg);
      background-size: 96px 96px;
      color: var(--ink);
      font-family: var(--font-display);
      padding: 72px;
    }

    .slide.active,
    .slide.visible {
      visibility: visible;
      opacity: 1;
      pointer-events: auto;
      z-index: 1;
    }

    img, video, canvas, svg {
      max-width: 100%;
      max-height: 100%;
    }

    .deck-controls {
      position: fixed;
      left: 50%;
      bottom: 22px;
      transform: translateX(-50%);
      z-index: 1000;
      display: flex;
      align-items: center;
      gap: 10px;
      color: #f7f0df;
      font: 600 13px var(--font-display);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      background: rgba(17, 17, 15, 0.72);
      border: 1px solid rgba(247, 240, 223, 0.18);
      border-radius: 999px;
      padding: 10px 16px;
      backdrop-filter: blur(18px);
    }

    @media print {
      html, body {
        width: 1920px;
        height: auto;
        overflow: visible;
        background: #fff;
      }

      .deck-viewport {
        position: static;
        overflow: visible;
        background: #fff;
      }

      .deck-stage {
        position: static;
        width: auto;
        height: auto;
        transform: none !important;
        background: none;
      }

      .slide {
        position: relative;
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
        width: 1920px;
        height: 1080px;
        break-after: page;
        page-break-after: always;
      }

      .slide:last-child {
        break-after: auto;
        page-break-after: auto;
      }

      .deck-controls {
        display: none !important;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.2s !important;
      }
    }

    .reveal {
      opacity: 0;
      transform: translateY(28px);
      transition: opacity 680ms cubic-bezier(0.16, 1, 0.3, 1),
        transform 680ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .slide.visible .reveal {
      opacity: 1;
      transform: translateY(0);
    }

    .reveal:nth-child(2) { transition-delay: 90ms; }
    .reveal:nth-child(3) { transition-delay: 180ms; }
    .reveal:nth-child(4) { transition-delay: 270ms; }

    .slide-label {
      display: inline-flex;
      align-items: center;
      gap: 14px;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .slide-label::before {
      content: "";
      width: 64px;
      height: 10px;
      border-radius: 999px;
      background: var(--accent);
      border: 2px solid var(--line);
    }

    h1, h2, h3, p { margin: 0; }

    h1 {
      max-width: 1320px;
      font-size: 132px;
      line-height: 0.94;
      letter-spacing: 0;
      font-weight: 800;
    }

    h2 {
      max-width: 1100px;
      font-size: 82px;
      line-height: 0.98;
      letter-spacing: 0;
      font-weight: 800;
    }

    .serif {
      font-family: var(--font-serif);
      font-weight: 400;
    }

    .muted {
      color: var(--muted);
    }

    .title-slide {
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 54px;
    }

    .title-grid {
      align-self: end;
      display: grid;
      grid-template-columns: 1fr 420px;
      gap: 72px;
      align-items: end;
    }

    .title-summary {
      font: 400 38px/1.35 var(--font-serif);
      color: var(--muted);
    }

    .stamp {
      width: 360px;
      height: 360px;
      border: 6px solid var(--line);
      border-radius: 28px;
      background: var(--accent);
      display: grid;
      place-items: center;
      transform: rotate(4deg);
      box-shadow: 20px 20px 0 var(--line);
    }

    .stamp span {
      font-size: 62px;
      font-weight: 800;
      text-align: center;
      line-height: 0.92;
      text-transform: uppercase;
    }

    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 18px;
    }

    .kpi {
      min-height: 150px;
      border: 3px solid var(--line);
      border-radius: 18px;
      padding: 24px;
      background: var(--paper);
      box-shadow: 8px 8px 0 var(--line);
    }

    .kpi-label {
      font-size: 20px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 800;
    }

    .kpi-value {
      margin-top: 14px;
      font-size: 58px;
      line-height: 1;
      font-weight: 800;
    }

    .tone-good .kpi-value { color: var(--accent-3); }
    .tone-warning .kpi-value { color: #a36d00; }
    .tone-critical .kpi-value { color: var(--danger); }

    .split {
      display: grid;
      grid-template-columns: 0.86fr 1.14fr;
      gap: 52px;
      height: 100%;
    }

    .panel {
      border: 3px solid var(--line);
      border-radius: 22px;
      background: rgba(255, 250, 240, 0.78);
      padding: 34px;
      box-shadow: 10px 10px 0 var(--line);
    }

    .funnel-list, .evidence-list {
      display: grid;
      gap: 22px;
      margin-top: 42px;
    }

    .funnel-row, .evidence-row {
      display: grid;
      grid-template-columns: 70px 260px 1fr 80px;
      align-items: center;
      gap: 22px;
      font-size: 28px;
      font-weight: 800;
    }

    .evidence-row {
      grid-template-columns: 360px 1fr 80px;
    }

    .funnel-index {
      font-size: 24px;
      color: var(--muted);
    }

    .funnel-track, .evidence-track {
      height: 34px;
      border: 3px solid var(--line);
      border-radius: 999px;
      background: var(--paper);
      overflow: hidden;
    }

    .funnel-track div, .evidence-track div {
      width: var(--bar);
      height: 100%;
      background: linear-gradient(90deg, var(--accent), #ff8d55);
      border-right: 3px solid var(--line);
    }

    .evidence-track div {
      background: linear-gradient(90deg, var(--accent-2), #69d2ff);
    }

    .candidate-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 22px;
      margin-top: 42px;
    }

    .candidate-card {
      position: relative;
      min-height: 210px;
      border: 3px solid var(--line);
      border-radius: 22px;
      background: var(--paper);
      padding: 24px;
      display: grid;
      grid-template-columns: 72px 1fr 120px;
      gap: 20px;
      box-shadow: 8px 8px 0 var(--line);
    }

    .candidate-rank {
      width: 60px;
      height: 60px;
      border-radius: 16px;
      border: 3px solid var(--line);
      background: var(--accent);
      display: grid;
      place-items: center;
      font-size: 22px;
      font-weight: 800;
    }

    .candidate-card h3 {
      font-size: 36px;
      line-height: 1;
      font-weight: 800;
    }

    .candidate-card p {
      margin-top: 10px;
      font-size: 20px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 800;
    }

    .candidate-score {
      justify-self: end;
      font-size: 46px;
      font-weight: 800;
    }

    .candidate-meta {
      grid-column: 2 / -1;
      display: flex;
      gap: 12px;
      align-items: end;
      flex-wrap: wrap;
      font-size: 18px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 800;
    }

    .coverage-grid {
      display: grid;
      grid-template-columns: repeat(10, 1fr);
      gap: 12px;
      margin-top: 42px;
    }

    .coverage-grid span {
      aspect-ratio: 1;
      border: 3px solid var(--line);
      border-radius: 8px;
      background: var(--paper);
    }

    .coverage-grid .filled {
      background: var(--accent-3);
    }

    .big-number {
      font-size: 180px;
      line-height: 0.85;
      font-weight: 800;
      letter-spacing: -3px;
    }

    .risk-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 22px;
      margin-top: 42px;
    }

    .risk-card {
      min-height: 260px;
      border: 3px solid var(--line);
      border-radius: 22px;
      background: var(--paper);
      padding: 28px;
      box-shadow: 8px 8px 0 var(--line);
    }

    .risk-card h3 {
      font-size: 34px;
      line-height: 1;
      font-weight: 800;
    }

    .risk-card p {
      margin-top: 20px;
      font: 400 26px/1.32 var(--font-serif);
      color: var(--muted);
    }

    .closing {
      display: grid;
      grid-template-columns: 1fr 540px;
      gap: 72px;
      align-items: center;
      height: 100%;
    }

    .closing p {
      margin-top: 34px;
      max-width: 980px;
      font: 400 40px/1.32 var(--font-serif);
      color: var(--muted);
    }

    .technical-stack {
      display: grid;
      gap: 18px;
    }

    .stack-item {
      border: 3px solid var(--line);
      border-radius: 18px;
      background: var(--paper);
      padding: 26px;
      font-size: 30px;
      font-weight: 800;
      box-shadow: 8px 8px 0 var(--line);
    }
  </style>
</head>
<body>
  <div class="deck-viewport">
    <main class="deck-stage" id="deckStage">
      <section class="slide title-slide active">
        <div class="slide-label reveal">ADR visual system</div>
        <div class="title-grid">
          <div>
            <h1 class="reveal">${safeTitle}</h1>
            <p class="title-summary reveal">${escapeHtml(report.decision.summary || "Evidence, tradeoffs, and visual reasoning from the ADR pipeline.")}</p>
          </div>
          <div class="stamp reveal"><span>${escapeHtml(statusLabel)}</span></div>
        </div>
        <div class="kpi-grid reveal">
          ${renderKpiStrip(report)}
        </div>
      </section>

      <section class="slide">
        <div class="slide-label reveal">Decision funnel</div>
        <div class="split">
          <div class="panel reveal">
            <h2>From noise to usable signal</h2>
            <p class="title-summary" style="margin-top:32px;">ADR narrows raw research into evidence-backed options, ranked decisions, and implementation context.</p>
          </div>
          <div class="panel reveal">
            <div class="funnel-list">
              ${renderFunnel(report.decisionFunnel)}
            </div>
          </div>
        </div>
      </section>

      <section class="slide">
        <div class="slide-label reveal">Evidence mix</div>
        <div class="split">
          <div class="panel reveal">
            <h2>What kind of proof do we have?</h2>
            <p class="title-summary" style="margin-top:32px;">The report separates mature OSS, engineering writeups, private corpus evidence, and weaker ambient signals.</p>
          </div>
          <div class="panel reveal">
            <div class="evidence-list">
              ${renderEvidenceMix(report.evidenceMix)}
            </div>
          </div>
        </div>
      </section>

      <section class="slide">
        <div class="slide-label reveal">Candidate scorecards</div>
        <h2 class="reveal">${topCandidate ? `Top option: ${escapeHtml(topCandidate.label)}` : "No promoted option yet"}</h2>
        <div class="candidate-grid reveal">
          ${renderCandidateCards(candidates)}
        </div>
      </section>

      <section class="slide">
        <div class="slide-label reveal">Coverage and risk</div>
        <div class="split">
          <div class="panel reveal">
            <div class="big-number">${escapeHtml(report.matrixCoverage.coveragePercent)}%</div>
            <p class="title-summary" style="margin-top:28px;">Matrix coverage across ${escapeHtml(report.matrixCoverage.axes)} axes and ${escapeHtml(report.matrixCoverage.candidates)} candidates.</p>
            <div class="coverage-grid">${renderCoverageGrid(report)}</div>
          </div>
          <div class="panel reveal">
            <h2>Risk signals</h2>
            <div class="risk-grid" style="margin-top:32px;">
              ${renderRiskSignals(report)}
            </div>
          </div>
        </div>
      </section>

      <section class="slide">
        <div class="closing">
          <div>
            <div class="slide-label reveal">Rendering contract</div>
            <h2 class="reveal">ADR writes the intelligence. Beevibe renders the artifact.</h2>
            <p class="reveal">The deck is generated from visual-report JSON, so newsletters, community pages, and decision reviews all share the same source of truth.</p>
          </div>
          <div class="technical-stack reveal">
            <div class="stack-item">ADR artifacts</div>
            <div class="stack-item">visual-report.json</div>
            <div class="stack-item">slide deck HTML</div>
            <div class="stack-item">community/newsletter embed</div>
          </div>
        </div>
      </section>
    </main>
  </div>
  <div class="deck-controls"><span id="slideCounter">01 / 06</span><span>Use arrows</span></div>
  <script>
    class SlidePresentation {
      constructor() {
        this.slides = Array.from(document.querySelectorAll('.slide'));
        this.currentSlide = 0;
        this.stage = document.getElementById('deckStage');
        this.counter = document.getElementById('slideCounter');
        this.setupStageScale();
        this.setupKeyboardNav();
        this.setupTouchNav();
        this.showSlide(0);
      }

      setupStageScale() {
        const scale = () => {
          const factor = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
          const x = (window.innerWidth - 1920 * factor) / 2;
          const y = (window.innerHeight - 1080 * factor) / 2;
          this.stage.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + factor + ')';
        };
        scale();
        window.addEventListener('resize', scale);
      }

      setupKeyboardNav() {
        window.addEventListener('keydown', (event) => {
          if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
            event.preventDefault();
            this.showSlide(this.currentSlide + 1);
          }
          if (['ArrowLeft', 'PageUp'].includes(event.key)) {
            event.preventDefault();
            this.showSlide(this.currentSlide - 1);
          }
          if (event.key === 'Home') this.showSlide(0);
          if (event.key === 'End') this.showSlide(this.slides.length - 1);
        });
      }

      setupTouchNav() {
        let startX = 0;
        window.addEventListener('touchstart', (event) => {
          startX = event.changedTouches[0]?.clientX ?? 0;
        }, { passive: true });
        window.addEventListener('touchend', (event) => {
          const endX = event.changedTouches[0]?.clientX ?? startX;
          const delta = endX - startX;
          if (Math.abs(delta) < 48) return;
          this.showSlide(this.currentSlide + (delta < 0 ? 1 : -1));
        }, { passive: true });
      }

      showSlide(index) {
        this.currentSlide = Math.max(0, Math.min(index, this.slides.length - 1));
        this.slides.forEach((slide, i) => {
          slide.classList.toggle('active', i === this.currentSlide);
          slide.classList.toggle('visible', i === this.currentSlide);
        });
        this.counter.textContent = String(this.currentSlide + 1).padStart(2, '0') + ' / ' + String(this.slides.length).padStart(2, '0');
      }
    }

    new SlidePresentation();
  </script>
</body>
</html>`;
}

async function loadReport(inputPath: string): Promise<{ report: AdrVisualReport; baseDir: string }> {
  const resolved = path.resolve(inputPath);
  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) {
    const report = await generateAdrVisualReport({
      runDir: resolved,
      outputJsonPath: path.join(resolved, "visual-report.json"),
      outputMarkdownPath: path.join(resolved, "visual-report.md"),
    });
    return { report, baseDir: resolved };
  }
  const raw = await fs.readFile(resolved, "utf-8");
  return { report: JSON.parse(raw) as AdrVisualReport, baseDir: path.dirname(resolved) };
}

async function renderAdrSlideDeck(inputPath: string, outputPath?: string): Promise<string> {
  const { report, baseDir } = await loadReport(inputPath);
  const safeName = slugify(report.decision.id || report.sourceRun || "adr-report");
  const target = outputPath ? path.resolve(outputPath) : path.join(baseDir, `${safeName}-deck.html`);
  await fs.writeFile(target, renderAdrSlideDeckHtml(report));
  return target;
}

function parseArgs(argv: string[]): { inputPath: string; outputPath?: string } {
  const args = [...argv];
  const inputPath = args.shift();
  if (!inputPath || inputPath.startsWith("--")) {
    throw new Error("Usage: pnpm adr:slides <run-dir|visual-report.json> [--out path]");
  }
  let outputPath: string | undefined;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--out") outputPath = args.shift();
    else throw new Error(`Unknown argument: ${arg ?? ""}`);
  }
  return { inputPath, outputPath };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { inputPath, outputPath } = parseArgs(process.argv.slice(2));
  renderAdrSlideDeck(inputPath, outputPath)
    .then((target) => {
      console.log(`slide deck: ${target}`);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
