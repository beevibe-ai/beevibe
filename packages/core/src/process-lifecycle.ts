/**
 * Process-entrypoint scaffolding shared by the `api` and `scheduler`
 * binaries.
 *
 * `packages/api/src/main.ts` and `packages/scheduler/src/main.ts` were
 * the same 60-line file twice over, differing only in the log tag and in
 * which handles the bootstrap returns: the same `REQUIRED_ENV` list, the
 * same "collect every missing var then throw one message" loop, the same
 * `resolveMcpServerUrl` fallback, the same `stop(signal)` closure wired
 * to SIGINT + SIGTERM, and the same `main().catch` fatal handler.
 *
 * Splitting it this way keeps each binary's *own* wiring — its ports,
 * its start order, its extra config — in its own main.ts, and moves only
 * the parts that were textually identical here.
 *
 * `resolveRuntimeEnv` also tightens a footgun the copies shared: each
 * validated `process.env` and then separately re-read it with non-null
 * assertions (`process.env.DATABASE_URL!`) when building the bootstrap
 * config, so the check and the read were two statements in two files
 * that could drift apart. Validating and reading in one function leaves
 * a single place where those assertions are made, next to the check
 * that justifies them, and adding a required var is now one edit
 * instead of three.
 */

import { resolveMcpServerUrl, type EnvSnapshot } from "./env.js";

/**
 * The env every composition root needs, validated and read in one step.
 * Field names match the `BootstrapConfig` both binaries accept, so call
 * sites can spread this straight into `bootstrap({ ...env, … })`.
 */
export interface RuntimeEnv {
  databaseUrl: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  mcpServerUrl: string;
  /** Optional — bootstrap defaults to `~/.beevibe/workspaces`. */
  workspaceRoot?: string;
  /** Optional — bootstrap defaults to `<cwd>/skills`. */
  skillsSourceDir?: string;
}

/** Vars with no fallback; absence is fatal. */
const REQUIRED_ENV = ["DATABASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

/**
 * Validate and read the composition-root env.
 *
 * Reports *every* missing var in one throw rather than failing on the
 * first — an operator bringing up a fresh deploy fixes one round of
 * config instead of one var per restart. `BEEVIBE_MCP_SERVER_URL` is
 * checked through {@link resolveMcpServerUrl}, so a Railway deploy that
 * only sets `RAILWAY_PUBLIC_DOMAIN` still passes.
 */
export function resolveRuntimeEnv(env: EnvSnapshot): RuntimeEnv {
  const mcpServerUrl = resolveMcpServerUrl(env);

  const missing: string[] = REQUIRED_ENV.filter((k) => !env[k]);
  if (!mcpServerUrl) missing.push("BEEVIBE_MCP_SERVER_URL");
  // The `!mcpServerUrl` half is redundant at runtime — it's already in
  // `missing` — but it's what narrows the type for the return below.
  if (missing.length > 0 || !mcpServerUrl) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}. See .env.example for the full set.`,
    );
  }

  return {
    // Safe past the throw above: `missing` is empty, so each of these
    // is a present, non-empty string.
    databaseUrl: env.DATABASE_URL!,
    openaiApiKey: env.OPENAI_API_KEY!,
    anthropicApiKey: env.ANTHROPIC_API_KEY!,
    mcpServerUrl,
    workspaceRoot: env.WORKSPACE_ROOT,
    skillsSourceDir: env.BEEVIBE_SKILLS_DIR,
  };
}

/**
 * Drain on SIGINT / SIGTERM, then exit 0.
 *
 * A shutdown that throws is logged and still exits 0: the handles are
 * already unusable by then, and a non-zero exit would make an
 * orchestrator treat an ordinary redeploy as a crash loop.
 */
export function installShutdownHandlers(
  tag: string,
  shutdown: () => Promise<void>,
): void {
  const stop = async (signal: string): Promise<void> => {
    console.error(`[${tag}] ${signal} received, shutting down`);
    try {
      await shutdown();
    } catch (err) {
      console.error(`[${tag}] shutdown error:`, err);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop("SIGINT");
  });
  process.on("SIGTERM", () => {
    void stop("SIGTERM");
  });
}

/**
 * Run a binary's `main`, exiting 1 on an unhandled rejection.
 *
 * Without this an env-validation throw would surface as node's default
 * `UnhandledPromiseRejection` trace and — depending on node version and
 * flags — an exit code an orchestrator may not treat as a failure.
 */
export function runEntrypoint(tag: string, main: () => Promise<void>): void {
  main().catch((err: unknown) => {
    console.error(`[${tag}] fatal:`, err);
    process.exit(1);
  });
}
