/**
 * Fixture data for the "tool run" half of the tools POC.
 *
 * A "tool run" = one sandboxed `use_repo` call: a child agent borrowed an
 * external repo, tried to accomplish a goal, and either produced artifacts
 * or stopped cheaply. A "saved tool" = a run the team chose to keep as a
 * reusable skill.
 *
 * Types stay shallow on purpose — what's not surfaced in the UI doesn't
 * need to be in the fixture. Anything technical (pinned commits, install
 * attempts, network flags) lives in a single `details` sub-object that the
 * UI only renders behind a "Show details" disclosure.
 */
export type ArtifactKind = "markdown" | "json" | "text" | "image" | "binary";

export interface Artifact {
  id: string;
  /** Sandbox path, e.g. `artifacts/launch-v2/blog-post.md`. */
  path: string;
  kind: ArtifactKind;
  title: string;
  size_bytes: number;
  /** Inline preview body. Null for binary / oversized artifacts. */
  preview: string | null;
}

export type RunStatus = "running" | "succeeded" | "partial" | "blocked" | "failed";

export interface RunDetails {
  pinned_commit: string;
  elapsed_minutes: number;
  install_attempts: number;
  disk_mb: number;
  network_after_clone_used: boolean;
}

export interface ToolRun {
  id: string;
  task_id: string;
  session_short_id: string;
  agent_label: string;
  repo_url: string;
  /** Short name shown in the UI — e.g. `gtm-playbook`. */
  repo_short_name: string;
  /** Goal in the user's words. */
  goal: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  /** Plain summary of what came out of the run. */
  summary: string;
  /** Set when the run was blocked or failed. */
  blocked_reason: string | null;
  artifacts: Artifact[];
  details: RunDetails;
  /** True if the child drafted a reusable skill (i.e. there's something to save). */
  has_draft_skill: boolean;
  /** Local POC state — true once the user clicked "Save as team tool." */
  saved?: boolean;
}

export interface SavedTool {
  /** Slug, e.g. `gtm-playbook-example`. */
  name: string;
  display_name: string;
  /** What the tool does, in one sentence. */
  description: string;
  repo_url: string;
  use_count: number;
  last_used_at: string;
}

/* ───────────── fixtures ───────────── */

const GTM_TASK_ID = "task_demo_gtm_launch_analytics_v2";
const HARNESS_TASK_ID = "task_demo_cli_harness_for_videolib";
const BLOCKED_TASK_ID = "task_demo_blocked_repo_use";

export const FIXTURE_RUNS: ToolRun[] = [
  {
    id: "run_2026_05_12_001",
    task_id: GTM_TASK_ID,
    session_short_id: "snd-4ab9c2",
    agent_label: "GTM Captain",
    repo_url: "https://github.com/beevibe-ai/gtm-playbook-example",
    repo_short_name: "gtm-playbook",
    goal: "Draft launch artifacts for analytics dashboard v2",
    status: "succeeded",
    started_at: "2026-05-12T17:42:00Z",
    finished_at: "2026-05-12T17:48:21Z",
    summary: "Produced 4 markdown drafts: checklist, blog, social thread, customer email.",
    blocked_reason: null,
    has_draft_skill: true,
    saved: true,
    details: {
      pinned_commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      elapsed_minutes: 6,
      install_attempts: 1,
      disk_mb: 412,
      network_after_clone_used: false,
    },
    artifacts: [
      {
        id: "art_001",
        path: "artifacts/launch-v2/launch-checklist.md",
        kind: "markdown",
        title: "Launch checklist",
        size_bytes: 1820,
        preview: [
          "# Analytics Dashboard v2 — Launch Checklist",
          "",
          "## T-7 days",
          "- [ ] Lock final feature set and changelog",
          "- [ ] Brief support team on the top 5 expected questions",
          "- [ ] Pre-record 60s product demo loop",
          "",
          "## Launch day",
          "- [ ] Publish blog at 7:55am PT",
          "- [ ] Post social thread at 8:00am PT",
          "- [ ] Submit to HN at 8:05am PT",
          "- [ ] Customer email at 9:00am PT",
          "- [ ] Reply to first 50 HN comments inside 4h",
        ].join("\n"),
      },
      {
        id: "art_002",
        path: "artifacts/launch-v2/blog-post.md",
        kind: "markdown",
        title: "Blog post",
        size_bytes: 4210,
        preview: [
          "# Analytics Dashboard v2: same answers, half the clicks",
          "",
          "When we shipped v1, the most common piece of feedback wasn't \"add",
          "this metric.\" It was \"I know the answer is in here somewhere, but",
          "I have to click through three filters to find it.\"",
          "",
          "Today we're shipping v2 — a rebuilt query layer, saved views that",
          "remember the right things, and a faster path from question to chart.",
          "",
          "## What's new",
          "- Saved views remember filters AND time range.",
          "- Inline drill-downs — click a datapoint, see the underlying rows.",
          "- Query layer rewrite cuts median load from 1.8s to 380ms.",
        ].join("\n"),
      },
      {
        id: "art_003",
        path: "artifacts/launch-v2/social-thread.md",
        kind: "markdown",
        title: "Social thread",
        size_bytes: 980,
        preview: [
          "1/ analytics dashboard v2 is live — rebuilt query layer cuts",
          "median load from 1.8s to 380ms 🚀",
          "",
          "2/ the #1 piece of v1 feedback was \"i know the answer is here,",
          "i just can't find it fast.\" v2 is our answer.",
          "",
          "3/ saved views now remember filters AND time range. inline",
          "drill-downs let you click into a datapoint without leaving",
          "the chart.",
          "",
          "4/ live for all teams today. would love to hear what feels",
          "faster and what's still slow 👇",
        ].join("\n"),
      },
      {
        id: "art_004",
        path: "artifacts/launch-v2/customer-email.md",
        kind: "markdown",
        title: "Customer email",
        size_bytes: 720,
        preview: [
          "Subject: Your dashboard just got 4× faster (Analytics v2 is live)",
          "",
          "Hi {first_name},",
          "",
          "Analytics Dashboard v2 is live starting today. The biggest change",
          "is speed — median dashboard loads dropped from ~1.8s to ~380ms.",
          "Saved views also now remember filters AND time range (the #1",
          "thing we heard people wanted from v1).",
          "",
          "Nothing to migrate. Your existing dashboards are already on v2.",
          "",
          "— The beevibe team",
        ].join("\n"),
      },
    ],
  },
  {
    id: "run_2026_05_13_001",
    task_id: HARNESS_TASK_ID,
    session_short_id: "snd-7c2d10",
    agent_label: "Captain",
    repo_url: "https://github.com/example/videolib",
    repo_short_name: "videolib",
    goal: "Render an MP4 from a JSON scene description",
    status: "succeeded",
    started_at: "2026-05-13T02:14:00Z",
    finished_at: "2026-05-13T02:22:48Z",
    summary:
      "Generated a CLI harness, then rendered a 2-second fixture clip to verify it works end-to-end.",
    blocked_reason: null,
    has_draft_skill: true,
    saved: false,
    details: {
      pinned_commit: "9f8e7d6c5b4a39281706f5e4d3c2b1a09876fedc",
      elapsed_minutes: 8,
      install_attempts: 1,
      disk_mb: 1830,
      network_after_clone_used: true,
    },
    artifacts: [
      {
        id: "art_h1",
        path: "artifacts/cli-harness/README.md",
        kind: "markdown",
        title: "Generated harness README",
        size_bytes: 1380,
        preview: [
          "# videolib harness",
          "",
          "Use:",
          "",
          "```bash",
          "videolib-harness render --input scene.json --output clip.mp4",
          "```",
          "",
          "Inputs: a videolib scene JSON. Outputs: H.264 MP4, ≤ 60s.",
          "Sandbox only. No GPU. ~2GB disk recommended.",
        ].join("\n"),
      },
      {
        id: "art_h2",
        path: "artifacts/cli-harness/fixture-render.mp4",
        kind: "binary",
        title: "Fixture render",
        size_bytes: 624_000,
        preview: null,
      },
      {
        id: "art_h3",
        path: "artifacts/cli-harness/run-summary.json",
        kind: "json",
        title: "Run summary",
        size_bytes: 380,
        preview: JSON.stringify(
          {
            repo: "example/videolib",
            harness_commands: ["render", "probe"],
            fixture_render_seconds: 2,
            artifact_size_bytes: 624000,
          },
          null,
          2,
        ),
      },
    ],
  },
  {
    id: "run_2026_05_13_002",
    task_id: BLOCKED_TASK_ID,
    session_short_id: "snd-aa1b22",
    agent_label: "Captain",
    repo_url: "https://github.com/example/headless-suite",
    repo_short_name: "headless-suite",
    goal: "Run the headless-suite test pack on our e2e fixtures",
    status: "blocked",
    started_at: "2026-05-13T03:01:00Z",
    finished_at: "2026-05-13T03:09:40Z",
    summary: "Couldn't install — needed kernel features and a GPU the sandbox doesn't grant.",
    blocked_reason:
      "Repo requires privileged kernel features and a CUDA-capable GPU.",
    has_draft_skill: false,
    saved: false,
    details: {
      pinned_commit: "11223344556677889900aabbccddeeff00112233",
      elapsed_minutes: 9,
      install_attempts: 2,
      disk_mb: 740,
      network_after_clone_used: true,
    },
    artifacts: [
      {
        id: "art_b1",
        path: "logs/install-attempt-1.log",
        kind: "text",
        title: "Install attempt 1 — tail",
        size_bytes: 420,
        preview: [
          "+ pip install -e .",
          "  error: requires kernel feature `userns` (privileged)",
          "ERROR: Failed building wheel for headless-runner",
        ].join("\n"),
      },
    ],
  },
];

export const FIXTURE_SAVED_TOOLS: SavedTool[] = [
  {
    name: "gtm-playbook-example",
    display_name: "GTM Launch Playbook",
    description:
      "Drafts a launch package (blog, checklist, social, email) from a product brief.",
    repo_url: "https://github.com/beevibe-ai/gtm-playbook-example",
    use_count: 7,
    last_used_at: "2026-05-13T01:18:00Z",
  },
];

/* ───────────── helpers used by the components ───────────── */

export function getRunsForTask(taskId: string): ToolRun[] {
  return FIXTURE_RUNS.filter((r) => r.task_id === taskId);
}

export function getSavedToolsForAgentHierarchy(
  // hierarchy is accepted so the call site reads cleanly; in the POC the
  // saved-tool list isn't actually scoped per role yet.
  hierarchy: "ic" | "team" | "org",
): SavedTool[] {
  void hierarchy;
  return FIXTURE_SAVED_TOOLS;
}

/* ─── tiny formatters (keep these in one place so the UI stays terse) ─── */

export function shortRepoLabel(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/github\.com\//, "");
}

export function formatDurationMinutes(minutes: number): string {
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatDiskMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
