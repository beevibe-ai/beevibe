/**
 * Fixture data for the discovery half of the tools POC.
 *
 * Hand-authored candidate lists per goal — when the backend ships, this
 * module shrinks to type re-exports and the hooks switch to an MCP-backed
 * React Query call.
 *
 * Kept deliberately small: the UI shows a name, a short description, a
 * single qualitative fit label, and one human-readable line about the
 * team's history with it. Anything richer (scores, weights, signal
 * vectors) is an internal scoring detail and not surfaced.
 */
export type Fit = "high" | "medium" | "low";
export type NextStep = "run" | "inspect_first" | "ask";

export interface Candidate {
  id: string;
  repo_url: string;
  display_name: string;
  /** One sentence — what this repo does, in plain language. */
  short_description: string;
  fit: Fit;
  /** One-line reason, shown under the row when expanded. */
  reason: string;
  license: string;
  /** Number of times the caller's team has used this repo successfully. 0 = first time. */
  prior_team_uses: number;
  /** Number of times the org has used it (used for cold-start signal). */
  prior_org_uses: number;
  next: NextStep;
}

export interface DiscoveryResult {
  /** Slug the page uses for routing/lookups. */
  slug: string;
  /** Plain-language goal, shown as a chip. */
  goal: string;
  candidates: Candidate[];
}

export const FIXTURE_GOALS: DiscoveryResult[] = [
  {
    slug: "pdf-tables",
    goal: "Extract tables from PDFs",
    candidates: [
      {
        id: "pdfplumber",
        repo_url: "https://github.com/jsvine/pdfplumber",
        display_name: "pdfplumber",
        short_description:
          "Pure-Python PDF text and table extraction with a clean CLI.",
        fit: "high",
        reason: "Clean CLI, MIT, examples directory, no system deps.",
        license: "MIT",
        prior_team_uses: 0,
        prior_org_uses: 0,
        next: "run",
      },
      {
        id: "tabula-py",
        repo_url: "https://github.com/chezou/tabula-py",
        display_name: "tabula-py",
        short_description: "Strong on bordered tables. Needs a JVM.",
        fit: "medium",
        reason: "Good accuracy but adds ~300MB of Java install.",
        license: "MIT",
        prior_team_uses: 0,
        prior_org_uses: 0,
        next: "inspect_first",
      },
      {
        id: "camelot",
        repo_url: "https://github.com/atlanhq/camelot",
        display_name: "camelot",
        short_description: "Tuned for complex layouts. Needs Ghostscript.",
        fit: "medium",
        reason: "System packages required; OK if the layout demands it.",
        license: "MIT",
        prior_team_uses: 0,
        prior_org_uses: 0,
        next: "inspect_first",
      },
    ],
  },
  {
    slug: "gtm-launch",
    goal: "Draft launch artifacts for a product update",
    candidates: [
      {
        id: "gtm-playbook",
        repo_url: "https://github.com/beevibe-ai/gtm-playbook-example",
        display_name: "gtm-playbook",
        short_description:
          "Generates blog, checklist, social thread, and email from a brief.",
        fit: "high",
        reason: "Your team has used this 7 times and saved it.",
        license: "MIT",
        prior_team_uses: 7,
        prior_org_uses: 14,
        next: "run",
      },
      {
        id: "launch-doc-generator",
        repo_url: "https://github.com/example/launch-doc-generator",
        display_name: "launch-doc-generator",
        short_description: "LLM-backed launch document generator.",
        fit: "medium",
        reason: "Better long-form prose but needs an OpenAI key.",
        license: "Apache-2.0",
        prior_team_uses: 0,
        prior_org_uses: 1,
        next: "ask",
      },
    ],
  },
  {
    slug: "json-to-mp4",
    goal: "Render an MP4 from a JSON scene",
    candidates: [
      {
        id: "videolib",
        repo_url: "https://github.com/example/videolib",
        display_name: "videolib",
        short_description:
          "JSON-driven 2D scene renderer with an offline CLI.",
        fit: "high",
        reason: "Used once before for this kind of task — worked cleanly.",
        license: "MIT",
        prior_team_uses: 1,
        prior_org_uses: 1,
        next: "run",
      },
      {
        id: "manimcli",
        repo_url: "https://github.com/example/manimcli",
        display_name: "manimcli",
        short_description: "Mathematical animation engine. Heavy install.",
        fit: "low",
        reason: "Wrong input shape (Python class, not JSON) and bulky deps.",
        license: "MIT",
        prior_team_uses: 0,
        prior_org_uses: 0,
        next: "ask",
      },
    ],
  },
];

/* ── small helpers used by the panel ── */

export function getGoalBySlug(slug: string): DiscoveryResult | undefined {
  return FIXTURE_GOALS.find((g) => g.slug === slug);
}

/**
 * Human-readable history line for a candidate. Returns a neutral string
 * when there's nothing to say (cold start).
 */
export function historyLine(c: Candidate): string {
  if (c.prior_team_uses > 0) {
    return `Your team has used this ${c.prior_team_uses}×`;
  }
  if (c.prior_org_uses > 0) {
    return `Used ${c.prior_org_uses}× across your org`;
  }
  return "First time trying this kind of task";
}

const FIT_LABEL: Record<Fit, string> = {
  high: "Good fit",
  medium: "Worth trying",
  low: "Probably not",
};

export function fitLabel(fit: Fit): string {
  return FIT_LABEL[fit];
}

const NEXT_LABEL: Record<NextStep, string> = {
  run: "Run this",
  inspect_first: "Try this",
  ask: "Try anyway",
};

export function nextLabel(next: NextStep): string {
  return NEXT_LABEL[next];
}
