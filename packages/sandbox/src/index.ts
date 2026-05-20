/**
 * Beevibe sandbox — Docker-backed isolated workspace primitives.
 *
 * See `./docker.ts` for the full surface. The MCP server wrapper that
 * exposes these to a child claude session lives in `./mcp-server.ts`.
 */
export {
  ALLOWED_CLONE_HOSTS,
  cleanupArtifactDir,
  createSandbox,
  DEFAULT_IMAGE,
  destroySandbox,
  ensureArtifactDir,
  exec,
  exportArtifact,
  listDir,
  prepareBaseEnvironment,
  readFileIn,
  SandboxError,
  writeFileIn,
  type ExecResult,
  type Sandbox,
  type SandboxLimits,
  type SandboxOptions,
} from "./docker.js";
