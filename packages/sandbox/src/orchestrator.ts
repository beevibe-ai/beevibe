/**
 * Orchestrator for "agent uses an external repo inside a sandbox."
 *
 * Flow:
 *   1. Create a fresh Docker sandbox.
 *   2. Install git + curl on top of the base image.
 *   3. (optional) fetch a sample input file into the sandbox so the
 *      agent has something to operate on.
 *   4. Write an MCP config pointing to the per-run sandbox MCP server.
 *   5. Spawn `claude --print` with that MCP config, with Bash/Read/Edit
 *      disabled and only the `mcp__beevibe-sandbox__*` tools allowed.
 *   6. Stream the agent's transcript while it works.
 *   7. Once the agent exits, scan the artifact dir for files +
 *      sidecar metadata.
 *   8. Tear down the sandbox.
 *
 * The agent is the driver. The orchestrator never tells it which
 * commands to run — it provides the repo URL, the goal, the input
 * location, and the sandbox tools, and the agent figures out
 * `git clone`, `pip install`, glue scripts, etc. on its own.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSandbox,
  destroySandbox,
  exec as sandboxExec,
  prepareBaseEnvironment,
  type Sandbox,
} from "./docker.js";

export type RunStatus = "starting" | "preparing" | "running" | "succeeded" | "blocked" | "failed";

export interface ArtifactMeta {
  filename: string;
  title: string;
  size_bytes: number;
  host_path: string;
  sandbox_path?: string;
}

export interface RunState {
  run_id: string;
  status: RunStatus;
  repo_url: string;
  goal: string;
  started_at: string;
  finished_at?: string;
  sandbox_id?: string;
  /** Streaming transcript — appended to as the agent works. */
  transcript: TranscriptEvent[];
  /** Whatever the agent exported via sandbox_export_artifact. */
  artifacts: ArtifactMeta[];
  /** Set when status is `blocked` or `failed`. */
  error?: string;
}

export interface TranscriptEvent {
  at: string;
  kind: "log" | "agent" | "tool_call" | "error";
  text: string;
}

export interface OrchestratorOptions {
  run_id: string;
  repo_url: string;
  goal: string;
  /**
   * Optional URL to fetch into /sandbox/inputs/ before the agent
   * runs. Useful for "operate on this PDF" type goals. The agent
   * is told the resulting in-sandbox path in its system prompt.
   */
  input_url?: string;
  input_filename?: string;
  /** Path to the `claude` CLI binary. Defaults to "claude" on PATH. */
  claude_bin?: string;
  /** Caps the agent's spend per run. Default $2. */
  max_budget_usd?: number;
  /** Hard wall-clock cap on the whole run. Default 600s. */
  max_runtime_seconds?: number;
  /**
   * Path to the sandbox MCP server entrypoint (the JS or TS file).
   * Default: `tsx <repoRoot>/packages/sandbox/src/mcp-server.ts`.
   */
  mcp_server_command?: { command: string; args: string[] };
  /** Callback fired every time RunState changes. */
  on_state?: (state: RunState) => void;
  /**
   * Env vars to set inside the sandbox container at create time
   * (via `docker run --env NAME=VALUE`). Used by use_repo to inject
   * decrypted person_secret values (API keys, tokens) so the child
   * agent can call cloud APIs from inside the sandbox.
   *
   * Never logged into the transcript — only the variable names are
   * surfaced in any debug output, never the values.
   */
  sandbox_env?: Record<string, string>;
}

const DEFAULT_PROMPT_HEADER = `\
You are a Beevibe sandbox child agent running inside a fresh Docker container.

You have ONLY these five MCP tools to touch the container. They are in your
tool list as deferred MCP tools — you MUST load each one via ToolSearch
before using it. ToolSearch's "select:" form only accepts ONE tool name per
call, so make five separate calls at the very start of your work:

  ToolSearch({ "query": "select:mcp__beevibe-sandbox__sandbox_exec", "max_results": 1 })
  ToolSearch({ "query": "select:mcp__beevibe-sandbox__sandbox_read_file", "max_results": 1 })
  ToolSearch({ "query": "select:mcp__beevibe-sandbox__sandbox_write_file", "max_results": 1 })
  ToolSearch({ "query": "select:mcp__beevibe-sandbox__sandbox_list", "max_results": 1 })
  ToolSearch({ "query": "select:mcp__beevibe-sandbox__sandbox_export_artifact", "max_results": 1 })

After those five ToolSearch calls, you may invoke the MCP tools directly:

  mcp__beevibe-sandbox__sandbox_exec(cmd, cwd?, timeout_seconds?)
  mcp__beevibe-sandbox__sandbox_read_file(path, max_bytes?)
  mcp__beevibe-sandbox__sandbox_write_file(path, content)
  mcp__beevibe-sandbox__sandbox_list(path)
  mcp__beevibe-sandbox__sandbox_export_artifact(sandbox_path, title?)

You have NO Bash, NO Read, NO Edit, NO Write tool — those will return errors.

The container has Python 3.12, git, and curl pre-installed. Operate inside
/sandbox. Use a project-local venv at /sandbox/venv.

Your job: use the external repo the user gives you to produce a real artifact
for the goal. Plan, install, run, verify, export. You succeed by exporting at
least one artifact under /sandbox/artifacts/ via sandbox_export_artifact. Stop
as soon as you've exported something useful — don't keep exploring. If you
can't, write REASON.txt explaining why and export that.`;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Hard caps to keep run state bounded.
 *
 * Without these the transcript grows unboundedly (every tool call +
 * result is an event) and the orchestrator's response payload to the
 * UI gets enormous. 500 events with 4KB-each ceilings keeps any single
 * RunState well under 2MB.
 */
const MAX_TRANSCRIPT_EVENTS = 500;
const MAX_EVENT_TEXT_BYTES = 4_000;
/** Friendly error rewrites for known failure modes from `docker`/`spawn`. */
function classifyStartupError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/Cannot connect to the Docker daemon/i.test(raw)) {
    return "Docker isn't running. Start Docker Desktop and try the run again.";
  }
  if (/ENOENT.*docker/i.test(raw)) {
    return "The `docker` CLI isn't on PATH. Install Docker Desktop (or set DOCKER_HOST).";
  }
  if (/no space left on device/i.test(raw)) {
    return "Docker is out of disk. Prune containers/images or expand Docker Desktop's allotment.";
  }
  return raw;
}

export async function runRepoAgent(opts: OrchestratorOptions): Promise<RunState> {
  const state: RunState = {
    run_id: opts.run_id,
    status: "starting",
    repo_url: opts.repo_url,
    goal: opts.goal,
    started_at: nowIso(),
    transcript: [],
    artifacts: [],
  };
  const emit = (): void => opts.on_state?.({ ...state, transcript: state.transcript.slice(), artifacts: state.artifacts.slice() });
  const log = (kind: TranscriptEvent["kind"], text: string): void => {
    const trimmed =
      text.length > MAX_EVENT_TEXT_BYTES
        ? text.slice(0, MAX_EVENT_TEXT_BYTES) +
          `\n…[truncated ${text.length - MAX_EVENT_TEXT_BYTES} bytes]…`
        : text;
    state.transcript.push({ at: nowIso(), kind, text: trimmed });
    // Drop oldest events when over the cap. Keep the first event
    // (usually the "Creating sandbox…" log) and the most recent N-1.
    if (state.transcript.length > MAX_TRANSCRIPT_EVENTS) {
      const overflow = state.transcript.length - MAX_TRANSCRIPT_EVENTS;
      state.transcript.splice(1, overflow);
      // Insert a synthetic notice on the first overflow so the UI
      // can show "log truncated" without inserting it every event.
      const alreadyMarked = state.transcript[1]?.text.startsWith("[log truncated:");
      if (!alreadyMarked) {
        state.transcript.splice(1, 0, {
          at: nowIso(),
          kind: "log",
          text: `[log truncated: dropped ${overflow} earlier event${overflow === 1 ? "" : "s"}]`,
        });
      }
    }
    emit();
  };

  let sandbox: Sandbox | null = null;
  try {
    log("log", "Creating sandbox container…");
    state.status = "preparing";
    emit();
    try {
      sandbox = await createSandbox({
        label: `bv-run-${opts.run_id}`,
        env: opts.sandbox_env,
      });
    } catch (err) {
      throw new Error(classifyStartupError(err));
    }
    state.sandbox_id = sandbox.id;
    log("log", `Sandbox ${sandbox.id} created (image ${sandbox.image}).`);
    if (opts.sandbox_env && Object.keys(opts.sandbox_env).length > 0) {
      // Log NAMES only, never values.
      log(
        "log",
        `Injected env vars: ${Object.keys(opts.sandbox_env).join(", ")}.`,
      );
    }

    log("log", "Installing git + curl in the sandbox base image…");
    await prepareBaseEnvironment(sandbox);
    log("log", "Base environment ready.");

    if (opts.input_url) {
      const filename = opts.input_filename ?? "input.bin";
      log("log", `Fetching input into /sandbox/inputs/${filename}…`);
      const r = await sandboxExec(
        sandbox,
        `mkdir -p /sandbox/inputs && curl -fsSL ${shellQuote(opts.input_url)} -o /sandbox/inputs/${shellQuote(filename)}`,
        { timeout_seconds: 120 },
      );
      if (r.exit_code !== 0) {
        throw new Error(`input fetch failed: ${r.stderr.trim().slice(0, 400)}`);
      }
      log("log", "Input file ready.");
    }

    // Write the MCP config the claude CLI will load.
    const mcpServerCommand = opts.mcp_server_command ?? defaultMcpServerCommand();
    const mcpConfigPath = join(sandbox.artifact_dir, "mcp-config.json");
    const mcpConfig = {
      mcpServers: {
        "beevibe-sandbox": {
          command: mcpServerCommand.command,
          args: mcpServerCommand.args,
          env: {
            BEEVIBE_SANDBOX_ID: sandbox.id,
            BEEVIBE_SANDBOX_ARTIFACTS: sandbox.artifact_dir,
          },
        },
      },
    };
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf8");
    log("log", `MCP config written: ${mcpConfigPath}`);

    // Build the prompt for the child agent.
    const userPrompt = buildUserPrompt(opts);
    const systemPromptAppend = DEFAULT_PROMPT_HEADER;

    state.status = "running";
    log("log", "Spawning child claude session…");
    emit();

    const claudeResult = await runClaude({
      claudeBin: opts.claude_bin ?? "claude",
      mcpConfigPath,
      systemPromptAppend,
      userPrompt,
      maxBudgetUsd: opts.max_budget_usd ?? 2,
      timeoutSeconds: opts.max_runtime_seconds ?? 600,
      onTranscript: (kind, text) => log(kind, text),
    });

    if (claudeResult.exit_code !== 0 && claudeResult.exit_code !== null) {
      const tail = claudeResult.stderr.slice(-500);
      log(
        "error",
        `Child claude exited with code ${claudeResult.exit_code}: ${tail}`,
      );
      state.status = claudeResult.timed_out ? "blocked" : "failed";
      state.error = claudeResult.timed_out
        ? `Run hit the ${opts.max_runtime_seconds ?? 600}s wall-clock budget — agent didn't finish in time.`
        : `Claude exited ${claudeResult.exit_code}.${tail ? " " + tail.slice(-200) : ""}`;
      state.finished_at = nowIso();
      emit();
      return state;
    }

    log("log", "Child claude exited cleanly. Collecting artifacts…");
    state.artifacts = await collectArtifacts(sandbox);
    if (state.artifacts.length === 0) {
      state.status = "blocked";
      state.error = "agent produced no artifacts";
    } else {
      state.status = "succeeded";
    }
    state.finished_at = nowIso();
    emit();
    return state;
  } catch (err) {
    log("error", err instanceof Error ? err.message : String(err));
    state.status = "failed";
    state.error = err instanceof Error ? err.message : String(err);
    state.finished_at = nowIso();
    emit();
    return state;
  } finally {
    if (sandbox) {
      // Cleanup must not change the run's outcome — swallow errors and
      // log them as a note rather than as a failure.
      try {
        log("log", `Destroying sandbox ${sandbox.id}…`);
        await destroySandbox(sandbox);
      } catch (err) {
        log(
          "log",
          `Sandbox cleanup note: ${err instanceof Error ? err.message : String(err)}. Run with \`docker ps -a --filter name=bv-run-\` to inspect.`,
        );
      }
    }
  }
}

function buildUserPrompt(opts: OrchestratorOptions): string {
  const lines = [
    `Goal: ${opts.goal}`,
    `Repo: ${opts.repo_url}`,
  ];
  if (opts.input_url) {
    lines.push(`Input file (pre-fetched): /sandbox/inputs/${opts.input_filename ?? "input.bin"}`);
  }
  lines.push("");
  lines.push("Work inside /sandbox. Clone the repo to /sandbox/repo. Install in a venv. ");
  lines.push("Produce at least one artifact under /sandbox/artifacts/, then call ");
  lines.push("sandbox_export_artifact() on each one with a short, human-readable title. ");
  lines.push("Stop as soon as you've exported a useful artifact — don't keep exploring.");
  return lines.join("\n");
}

const ALLOWED_TOOLS = [
  "mcp__beevibe-sandbox__sandbox_exec",
  "mcp__beevibe-sandbox__sandbox_read_file",
  "mcp__beevibe-sandbox__sandbox_write_file",
  "mcp__beevibe-sandbox__sandbox_list",
  "mcp__beevibe-sandbox__sandbox_export_artifact",
];

const DISALLOWED_TOOLS = ["Bash", "Read", "Edit", "Write", "BashOutput", "KillBash"];

interface ClaudeRunResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

function runClaude(args: {
  claudeBin: string;
  mcpConfigPath: string;
  systemPromptAppend: string;
  userPrompt: string;
  maxBudgetUsd: number;
  timeoutSeconds: number;
  onTranscript: (kind: TranscriptEvent["kind"], text: string) => void;
}): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const cliArgs = [
      "--print",
      "--mcp-config",
      args.mcpConfigPath,
      "--allowed-tools",
      ALLOWED_TOOLS.join(","),
      "--disallowed-tools",
      DISALLOWED_TOOLS.join(","),
      "--append-system-prompt",
      args.systemPromptAppend,
      "--max-budget-usd",
      String(args.maxBudgetUsd),
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    const proc = spawn(args.claudeBin, cliArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      // Detach the child from the parent's process group so claude
      // doesn't inherit signals sent to the API server's request
      // handlers (Next.js dev mode in particular forwards SIGTERM
      // to children of route handlers when the request completes).
      detached: true,
    });
    // Don't keep the parent waiting on the child's stdio after the
    // child exits.
    proc.unref();

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stdoutBuffer = "";

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, args.timeoutSeconds * 1000);

    proc.stdout.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stdout += s;
      stdoutBuffer += s;
      // Stream-json emits newline-delimited JSON. Parse what we can and
      // surface human-readable transcript events; preserve the buffer
      // for partial lines.
      let nl;
      while ((nl = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        try {
          const evt = JSON.parse(line) as unknown;
          // Surface the init event's MCP server status + tool list
          // explicitly so connection failures are obvious.
          if (
            evt &&
            typeof evt === "object" &&
            (evt as Record<string, unknown>).type === "system" &&
            (evt as Record<string, unknown>).subtype === "init"
          ) {
            const init = evt as Record<string, unknown>;
            const servers = init.mcp_servers as Array<{ name: string; status: string }> | undefined;
            if (servers) {
              for (const sv of servers) {
                args.onTranscript("log", `mcp server ${sv.name}: ${sv.status}`);
              }
            }
            const tools = init.tools as string[] | undefined;
            const mcpTools = (tools ?? []).filter((t) => t.startsWith("mcp__beevibe-sandbox__"));
            args.onTranscript(
              "log",
              `mcp tools exposed: ${mcpTools.length ? mcpTools.join(", ") : "none"}`,
            );
          }
          handleStreamEvent(evt, args.onTranscript);
        } catch {
          // Not JSON yet — could be a noise line, skip.
        }
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      const friendly = /ENOENT/i.test(err.message)
        ? `Claude CLI not found at ${args.claudeBin}. Set BEEVIBE_CLAUDE_BIN to the binary path.`
        : `claude spawn error: ${err.message}`;
      args.onTranscript("error", friendly);
      resolve({ exit_code: -1, stdout, stderr, timed_out: timedOut });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      // Surface stderr tail on non-zero exits so the orchestrator's
      // error message is actionable instead of "exit 143".
      if (code !== 0 && code !== null) {
        const tail = stderr.slice(-800).trim();
        if (tail) {
          args.onTranscript("error", `claude stderr tail: ${tail}`);
        }
      }
      resolve({ exit_code: code, stdout, stderr, timed_out: timedOut });
    });

    // Pipe the user prompt in via stdin (no risk of arg quoting issues).
    proc.stdin.write(args.userPrompt);
    proc.stdin.end();
  });
}

/**
 * Translate a stream-json event from claude CLI into a transcript line.
 * stream-json events have many shapes; we surface assistant text, tool
 * calls, and results in a tight way without dumping the raw JSON.
 */
function handleStreamEvent(
  evt: unknown,
  emit: (kind: TranscriptEvent["kind"], text: string) => void,
): void {
  if (!evt || typeof evt !== "object") return;
  const e = evt as Record<string, unknown>;
  const t = e.type as string | undefined;
  if (t === "assistant" || t === "assistant_message") {
    // Try to extract the text content
    const message = e.message as Record<string, unknown> | undefined;
    if (message && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (!item || typeof item !== "object") continue;
        const it = item as Record<string, unknown>;
        if (it.type === "text" && typeof it.text === "string") {
          emit("agent", it.text);
        } else if (it.type === "tool_use") {
          const name = String(it.name ?? "unknown");
          const input = it.input ? compactJson(it.input) : "";
          emit("tool_call", `${name}(${input})`);
        }
      }
    } else if (typeof e.content === "string") {
      emit("agent", e.content);
    }
  } else if (t === "user" || t === "user_message") {
    // Tool result blocks come back inside user messages. Surface a compact
    // form so the transcript reads as a real interleaving of calls + results.
    const message = e.message as Record<string, unknown> | undefined;
    if (message && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (!item || typeof item !== "object") continue;
        const it = item as Record<string, unknown>;
        if (it.type === "tool_result") {
          const content = it.content;
          let text: string;
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .map((c) =>
                c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string"
                  ? ((c as Record<string, unknown>).text as string)
                  : "",
              )
              .filter(Boolean)
              .join(" ");
          } else {
            text = JSON.stringify(content ?? null);
          }
          const isErr = (it as Record<string, unknown>).is_error === true;
          emit(isErr ? "error" : "tool_call", `→ ${text.slice(0, 300)}${text.length > 300 ? "…" : ""}`);
        }
      }
    }
  } else if (t === "result" && typeof e.result === "string") {
    emit("agent", e.result);
  } else if (t === "error") {
    emit("error", typeof e.message === "string" ? e.message : "claude error");
  }
}

function compactJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return "?";
  }
}

/**
 * Scan the sandbox's artifact dir for files exported via
 * sandbox_export_artifact. Reads any sidecar `.meta.json` files the MCP
 * server wrote so the artifact title shows up in the UI.
 */
async function collectArtifacts(sandbox: Sandbox): Promise<ArtifactMeta[]> {
  const out: ArtifactMeta[] = [];
  await mkdir(sandbox.artifact_dir, { recursive: true });
  const entries = await readdir(sandbox.artifact_dir);
  const sidecars = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    if (e.endsWith(".meta.json")) {
      try {
        const raw = await readFile(join(sandbox.artifact_dir, e), "utf8");
        sidecars.set(e.replace(/\.meta\.json$/, ""), JSON.parse(raw));
      } catch {
        // Skip bad sidecars.
      }
    }
  }
  for (const e of entries) {
    if (e.endsWith(".meta.json") || e === "mcp-config.json") continue;
    const hostPath = join(sandbox.artifact_dir, e);
    const stat = await readFile(hostPath).then(
      (b) => ({ size: b.byteLength }),
      () => null,
    );
    if (!stat) continue;
    const meta = sidecars.get(e);
    out.push({
      filename: e,
      title:
        (typeof meta?.title === "string" && meta.title) || e.replace(/\.[^.]+$/, ""),
      size_bytes: stat.size,
      host_path: hostPath,
      sandbox_path:
        (typeof meta?.sandbox_path === "string" && meta.sandbox_path) || undefined,
    });
  }
  return out;
}

function defaultMcpServerCommand(): { command: string; args: string[] } {
  // The MCP server is spawned by claude (as a child of the orchestrator),
  // which inherits claude's own cwd — not ours. Use an absolute path so
  // it always resolves regardless of who launched claude. This file
  // resolves from /packages/sandbox/dist/orchestrator.js when built, and
  // /packages/sandbox/src/orchestrator.ts when run via tsx — both
  // siblings of mcp-server.{js,ts}, so we just compute the path relative
  // to this module.
  const here = dirname(fileURLToPath(import.meta.url));
  const isTsxRun = here.endsWith("/src");
  const mcpServerPath = resolve(
    here,
    isTsxRun ? "./mcp-server.ts" : "./mcp-server.js",
  );
  return isTsxRun
    ? { command: "npx", args: ["--no-install", "tsx", mcpServerPath] }
    : { command: "node", args: ["--enable-source-maps", mcpServerPath] };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
