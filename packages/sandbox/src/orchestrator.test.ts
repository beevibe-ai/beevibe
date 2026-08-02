/**
 * Unit tests for the run orchestrator.
 *
 * `runRepoAgent` is the whole "agent borrows an external repo" flow:
 * create sandbox → prep → optional input fetch → write MCP config →
 * spawn a child `claude` → stream its transcript → collect artifacts →
 * tear down. It had no coverage at all, so none of the interesting
 * behaviour — startup-error rewriting, the transcript caps that keep
 * RunState under 2MB, stream-json parsing, artifact sidecars,
 * teardown-always — was verified anywhere.
 *
 * We stub `./docker.js` (no daemon) and `node:child_process` (no real
 * `claude`), keeping the artifact dir on the real filesystem so the
 * collection step is exercised for real.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ─────────── fakes ─────────── */

/** Scripted behaviour for the child `claude` process. */
interface ClaudeScript {
  /** stream-json lines written to stdout, in order. */
  lines?: unknown[];
  /** Raw stdout, used to test partial-line buffering. */
  rawChunks?: string[];
  stderr?: string;
  code?: number | null;
  /** Emit `error` (e.g. ENOENT) instead of exiting. */
  error?: string;
  /** Never exit, so the run's wall-clock timeout fires. */
  hang?: boolean;
}

let claudeScript: ClaudeScript = { code: 0 };
let spawnCalls: { bin: string; args: string[]; opts: Record<string, unknown> }[] = [];
let stdinWrites: string[] = [];

class FakeClaude extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    write: (s: string) => stdinWrites.push(s),
    end: () => {},
  };
  killed: string[] = [];
  #settled = false;

  kill(signal: string): boolean {
    this.killed.push(signal);
    this.#close(null);
    return true;
  }

  unref(): void {}

  run(script: ClaudeScript): void {
    queueMicrotask(() => {
      for (const chunk of script.rawChunks ?? []) {
        this.stdout.emit("data", Buffer.from(chunk, "utf8"));
      }
      for (const line of script.lines ?? []) {
        this.stdout.emit("data", Buffer.from(JSON.stringify(line) + "\n", "utf8"));
      }
      if (script.stderr) this.stderr.emit("data", Buffer.from(script.stderr, "utf8"));
      if (script.error) {
        this.#settled = true;
        this.emit("error", new Error(script.error));
        return;
      }
      if (script.hang) return;
      this.#close(script.code === undefined ? 0 : script.code);
    });
  }

  #close(code: number | null): void {
    if (this.#settled) return;
    this.#settled = true;
    this.emit("close", code);
  }
}

vi.mock("node:child_process", () => ({
  spawn: (bin: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ bin, args, opts });
    const proc = new FakeClaude();
    proc.run(claudeScript);
    return proc;
  },
}));

/** Behaviour of the stubbed docker layer, per test. */
let docker: {
  createSandbox: ReturnType<typeof vi.fn>;
  prepareBaseEnvironment: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  destroySandbox: ReturnType<typeof vi.fn>;
};

vi.mock("./docker.js", async (importActual) => {
  // shellQuote is pure and is the thing keeping a hostile input_url from
  // becoming a second shell command — keep the real one.
  const actual = await importActual<typeof import("./docker.js")>();
  return {
    shellQuote: actual.shellQuote,
    createSandbox: (...a: unknown[]) => docker.createSandbox(...a),
    prepareBaseEnvironment: (...a: unknown[]) => docker.prepareBaseEnvironment(...a),
    exec: (...a: unknown[]) => docker.exec(...a),
    destroySandbox: (...a: unknown[]) => docker.destroySandbox(...a),
  };
});

import { runRepoAgent, type RunState, type TranscriptEvent } from "./orchestrator.js";

/* ─────────── harness ─────────── */

const tempDirs: string[] = [];
let artifactDir: string;

/** Baseline options; every test overrides only what it cares about. */
function opts(over: Partial<Parameters<typeof runRepoAgent>[0]> = {}) {
  return {
    run_id: "run-1",
    repo_url: "https://github.com/jsvine/pdfplumber",
    goal: "extract the tables",
    mcp_server_command: { command: "node", args: ["/srv/mcp-server.js"] },
    ...over,
  };
}

/** Text of every transcript event of a given kind. */
function texts(state: RunState, kind?: TranscriptEvent["kind"]): string[] {
  return state.transcript.filter((e) => !kind || e.kind === kind).map((e) => e.text);
}

beforeEach(async () => {
  artifactDir = await mkdtemp(join(tmpdir(), "bv-orch-"));
  tempDirs.push(artifactDir);
  spawnCalls = [];
  stdinWrites = [];
  claudeScript = { code: 0 };
  docker = {
    createSandbox: vi.fn(async () => ({
      id: "bv-run-run-1-abcd1234",
      image: "python:3.12-slim",
      artifact_dir: artifactDir,
      created_at: new Date(),
    })),
    prepareBaseEnvironment: vi.fn(async () => {}),
    exec: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      duration_seconds: 0.1,
    })),
    destroySandbox: vi.fn(async () => {}),
  };
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Drop an exported artifact (and optional sidecar) into the artifact dir. */
async function placeArtifact(
  name: string,
  content: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(artifactDir, name), content, "utf8");
  if (meta) {
    await writeFile(join(artifactDir, `${name}.meta.json`), JSON.stringify(meta), "utf8");
  }
}

/* ─────────── happy path ─────────── */

describe("runRepoAgent — successful run", () => {
  it("succeeds and returns the artifacts the agent exported", async () => {
    await placeArtifact("tables.csv", "a,b\n1,2\n", {
      title: "Extracted tables",
      sandbox_path: "/sandbox/artifacts/tables.csv",
    });

    const state = await runRepoAgent(opts());

    expect(state.status).toBe("succeeded");
    expect(state.error).toBeUndefined();
    expect(state.artifacts).toEqual([
      {
        filename: "tables.csv",
        title: "Extracted tables",
        size_bytes: 8,
        host_path: join(artifactDir, "tables.csv"),
        sandbox_path: "/sandbox/artifacts/tables.csv",
      },
    ]);
    expect(state.finished_at).toBeDefined();
  });

  it("walks the sandbox lifecycle in order", async () => {
    await placeArtifact("out.txt", "x");

    const state = await runRepoAgent(opts());

    expect(docker.createSandbox).toHaveBeenCalledWith({ label: "bv-run-run-1" });
    expect(docker.prepareBaseEnvironment).toHaveBeenCalledOnce();
    expect(docker.destroySandbox).toHaveBeenCalledOnce();
    expect(state.sandbox_id).toBe("bv-run-run-1-abcd1234");
  });

  it("falls back to the filename when no sidecar title exists", async () => {
    await placeArtifact("report.pdf", "pdf-bytes");

    const state = await runRepoAgent(opts());

    // Extension stripped, so the UI shows "report" rather than "report.pdf".
    expect(state.artifacts[0]!.title).toBe("report");
    expect(state.artifacts[0]!.sandbox_path).toBeUndefined();
  });

  it("ignores the MCP config and sidecars when collecting artifacts", async () => {
    await placeArtifact("real.txt", "keep", { title: "Real" });

    const state = await runRepoAgent(opts());

    // mcp-config.json is written into the same dir by the orchestrator
    // itself; it is plumbing, not an agent artifact.
    expect(state.artifacts.map((a) => a.filename)).toEqual(["real.txt"]);
  });

  it("collects every exported artifact, not just the first", async () => {
    await placeArtifact("a.csv", "1");
    await placeArtifact("b.csv", "22");

    const state = await runRepoAgent(opts());

    expect(state.artifacts.map((a) => a.filename).sort()).toEqual(["a.csv", "b.csv"]);
    expect(state.artifacts.find((a) => a.filename === "b.csv")!.size_bytes).toBe(2);
  });

  it("survives an unparseable sidecar by falling back to the filename", async () => {
    await writeFile(join(artifactDir, "out.txt"), "x", "utf8");
    await writeFile(join(artifactDir, "out.txt.meta.json"), "{not json", "utf8");

    const state = await runRepoAgent(opts());

    expect(state.status).toBe("succeeded");
    expect(state.artifacts[0]!.title).toBe("out");
  });

  it("blocks rather than succeeding when the agent exported nothing", async () => {
    const state = await runRepoAgent(opts());

    expect(state.status).toBe("blocked");
    expect(state.error).toBe("agent produced no artifacts");
  });
});

/* ─────────── child claude invocation ─────────── */

describe("runRepoAgent — child claude session", () => {
  it("restricts the child to the sandbox MCP tools and denies host tools", async () => {
    await placeArtifact("out.txt", "x");
    await runRepoAgent(opts());

    const { args } = spawnCalls[0]!;
    const allowed = args[args.indexOf("--allowed-tools") + 1]!.split(",");
    const denied = args[args.indexOf("--disallowed-tools") + 1]!.split(",");

    // The containment guarantee: the child can only touch the container
    // through MCP, never through its own host tools.
    expect(allowed.every((t) => t.startsWith("mcp__beevibe-sandbox__"))).toBe(true);
    expect(allowed).toHaveLength(5);
    expect(denied).toEqual(expect.arrayContaining(["Bash", "Read", "Edit", "Write"]));
  });

  it("caps the child's spend and asks for streaming json", async () => {
    await placeArtifact("out.txt", "x");
    await runRepoAgent(opts({ max_budget_usd: 5 }));

    const { args } = spawnCalls[0]!;
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("5");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--print");
    expect(args).toContain("--verbose");
  });

  it("defaults the budget to $2", async () => {
    await placeArtifact("out.txt", "x");
    await runRepoAgent(opts());
    const { args } = spawnCalls[0]!;
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2");
  });

  it("detaches the child so a parent request teardown doesn't kill it", async () => {
    await placeArtifact("out.txt", "x");
    await runRepoAgent(opts());
    expect(spawnCalls[0]!.opts.detached).toBe(true);
  });

  it("honours a custom claude binary", async () => {
    await placeArtifact("out.txt", "x");
    await runRepoAgent(opts({ claude_bin: "/opt/bin/claude" }));
    expect(spawnCalls[0]!.bin).toBe("/opt/bin/claude");
  });

  it("passes the goal and repo through stdin rather than argv", async () => {
    await placeArtifact("out.txt", "x");
    await runRepoAgent(opts());

    const prompt = stdinWrites.join("");
    expect(prompt).toContain("Goal: extract the tables");
    expect(prompt).toContain("Repo: https://github.com/jsvine/pdfplumber");
    // Keeping the prompt off argv avoids any quoting hazard.
    expect(spawnCalls[0]!.args.join(" ")).not.toContain("extract the tables");
  });

  it("tells the agent where a pre-fetched input landed", async () => {
    await placeArtifact("out.txt", "x");
    await runRepoAgent(opts({ input_url: "https://example.com/a.pdf", input_filename: "a.pdf" }));

    expect(stdinWrites.join("")).toContain("Input file (pre-fetched): /sandbox/inputs/a.pdf");
  });

  it("omits the input line when no input was fetched", async () => {
    await placeArtifact("out.txt", "x");
    await runRepoAgent(opts());
    expect(stdinWrites.join("")).not.toContain("Input file (pre-fetched)");
  });

  it("writes an MCP config binding the server to this sandbox", async () => {
    await placeArtifact("out.txt", "x");
    await runRepoAgent(opts());

    const { args } = spawnCalls[0]!;
    const configPath = args[args.indexOf("--mcp-config") + 1]!;
    const config = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(configPath, "utf8")));

    expect(config.mcpServers["beevibe-sandbox"]).toEqual({
      command: "node",
      args: ["/srv/mcp-server.js"],
      env: {
        BEEVIBE_SANDBOX_ID: "bv-run-run-1-abcd1234",
        BEEVIBE_SANDBOX_ARTIFACTS: artifactDir,
      },
    });
  });

  it("falls back to a resolvable default MCP server command", async () => {
    await placeArtifact("out.txt", "x");
    // No mcp_server_command — the orchestrator must derive one from its
    // own module path, since claude inherits its own cwd, not ours.
    await runRepoAgent({ ...opts(), mcp_server_command: undefined });

    const { args } = spawnCalls[0]!;
    const configPath = args[args.indexOf("--mcp-config") + 1]!;
    const config = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(configPath, "utf8")));
    const server = config.mcpServers["beevibe-sandbox"];

    expect(server.args.at(-1)).toMatch(/^\/.*mcp-server\.(ts|js)$/);
    expect(["node", "npx"]).toContain(server.command);
  });
});

/* ─────────── input fetch ─────────── */

describe("runRepoAgent — input fetch", () => {
  it("curls the input into the sandbox before the agent starts", async () => {
    await placeArtifact("out.txt", "x");

    await runRepoAgent(
      opts({ input_url: "https://example.com/doc.pdf", input_filename: "doc.pdf" }),
    );

    const cmd = docker.exec.mock.calls[0]![1] as string;
    expect(cmd).toContain("mkdir -p /sandbox/inputs");
    expect(cmd).toContain("curl -fsSL 'https://example.com/doc.pdf'");
    expect(cmd).toContain("-o /sandbox/inputs/'doc.pdf'");
  });

  it("defaults the input filename to input.bin", async () => {
    await placeArtifact("out.txt", "x");
    await runRepoAgent(opts({ input_url: "https://example.com/x" }));
    expect(docker.exec.mock.calls[0]![1] as string).toContain("/sandbox/inputs/'input.bin'");
  });

  it("quotes the URL so a crafted input_url cannot inject a command", async () => {
    await placeArtifact("out.txt", "x");

    await runRepoAgent(opts({ input_url: "https://x/'; touch /pwned; '" }));

    const cmd = docker.exec.mock.calls[0]![1] as string;
    // The embedded quote is escaped rather than closing the argument.
    expect(cmd).toContain(`'https://x/'\\''; touch /pwned; '\\'''`);
  });

  it("fails the run when the input cannot be fetched", async () => {
    docker.exec.mockResolvedValue({
      stdout: "",
      stderr: "curl: (22) The requested URL returned error: 404",
      exit_code: 22,
      timed_out: false,
      duration_seconds: 0.2,
    });

    const state = await runRepoAgent(opts({ input_url: "https://example.com/missing.pdf" }));

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/input fetch failed.*404/);
    // No point spawning the agent when its input is missing.
    expect(spawnCalls).toHaveLength(0);
    expect(docker.destroySandbox).toHaveBeenCalledOnce();
  });

  it("skips the fetch entirely when no input_url is given", async () => {
    await placeArtifact("out.txt", "x");
    await runRepoAgent(opts());
    expect(docker.exec).not.toHaveBeenCalled();
  });
});

/* ─────────── startup error rewriting ─────────── */

describe("runRepoAgent — startup failures", () => {
  it.each([
    ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock", /Docker isn't running/],
    ["spawn docker ENOENT", /`docker` CLI isn't on PATH/],
    ["write /var/lib/docker: no space left on device", /Docker is out of disk/],
  ])("rewrites %s into an actionable message", async (raw, expected) => {
    docker.createSandbox.mockRejectedValue(new Error(raw));

    const state = await runRepoAgent(opts());

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(expected);
  });

  it("passes an unrecognized startup error through unchanged", async () => {
    docker.createSandbox.mockRejectedValue(new Error("some novel docker failure"));

    const state = await runRepoAgent(opts());

    expect(state.error).toBe("some novel docker failure");
  });

  it("does not try to tear down a sandbox that was never created", async () => {
    docker.createSandbox.mockRejectedValue(new Error("nope"));

    await runRepoAgent(opts());

    expect(docker.destroySandbox).not.toHaveBeenCalled();
  });

  it("fails the run when base preparation fails", async () => {
    docker.prepareBaseEnvironment.mockRejectedValue(new Error("base prep failed (exit 100)"));

    const state = await runRepoAgent(opts());

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/base prep failed/);
    // The container exists by now, so it still has to be reclaimed.
    expect(docker.destroySandbox).toHaveBeenCalledOnce();
  });
});

/* ─────────── child exit handling ─────────── */

describe("runRepoAgent — child exit handling", () => {
  it("fails the run when claude exits non-zero", async () => {
    claudeScript = { code: 1, stderr: "auth error: invalid API key" };

    const state = await runRepoAgent(opts());

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/Claude exited 1/);
    expect(state.error).toContain("invalid API key");
  });

  it("blocks with a budget message when the run hits its wall clock", async () => {
    // A child we kill closes with a null exit code, so this lands on the
    // artifact-collection path rather than the non-zero-exit path.
    claudeScript = { hang: true };

    const state = await runRepoAgent(opts({ max_runtime_seconds: 0.05 }));

    expect(state.status).toBe("blocked");
    expect(state.error).toMatch(/hit the 0.05s wall-clock budget/);
    // The reason must be the timeout, not a misleading "exported nothing".
    expect(state.error).not.toMatch(/produced no artifacts/);
  });

  it("keeps a timed-out agent's artifacts instead of discarding them", async () => {
    await placeArtifact("partial.csv", "a,b\n");
    claudeScript = { hang: true };

    const state = await runRepoAgent(opts({ max_runtime_seconds: 0.05 }));

    // Running out of clock doesn't invalidate what was already exported.
    expect(state.status).toBe("succeeded");
    expect(state.artifacts.map((a) => a.filename)).toEqual(["partial.csv"]);
  });

  it("reports a missing claude binary as an actionable error", async () => {
    claudeScript = { error: "spawn claude ENOENT" };

    const state = await runRepoAgent(opts());

    expect(state.status).toBe("failed");
    expect(texts(state, "error").join("\n")).toMatch(/Claude CLI not found at claude/);
  });

  it("surfaces the stderr tail as its own transcript event", async () => {
    claudeScript = { code: 2, stderr: "traceback: something broke" };

    const state = await runRepoAgent(opts());

    expect(texts(state, "error").join("\n")).toContain("claude stderr tail: traceback: something broke");
  });

  it("still collects artifacts when the child exits cleanly", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = { code: 0 };

    const state = await runRepoAgent(opts());

    expect(state.status).toBe("succeeded");
  });
});

/* ─────────── stream-json transcript ─────────── */

describe("runRepoAgent — transcript from stream-json", () => {
  it("surfaces assistant text as agent events", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = {
      code: 0,
      lines: [{ type: "assistant", message: { content: [{ type: "text", text: "Cloning repo…" }] } }],
    };

    const state = await runRepoAgent(opts());

    expect(texts(state, "agent")).toContain("Cloning repo…");
  });

  it("renders a tool call with its compacted input", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = {
      code: 0,
      lines: [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "mcp__beevibe-sandbox__sandbox_exec", input: { cmd: "ls" } },
            ],
          },
        },
      ],
    };

    const state = await runRepoAgent(opts());

    expect(texts(state, "tool_call")).toContain(
      'mcp__beevibe-sandbox__sandbox_exec({"cmd":"ls"})',
    );
  });

  it("truncates an oversized tool input rather than dumping it", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = {
      code: 0,
      lines: [
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "t", input: { blob: "z".repeat(500) } }],
          },
        },
      ],
    };

    const state = await runRepoAgent(opts());

    const call = texts(state, "tool_call").find((t) => t.startsWith("t("))!;
    expect(call).toContain("…");
    expect(call.length).toBeLessThan(260);
  });

  it("surfaces tool results from user messages", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = {
      code: 0,
      lines: [
        { type: "user", message: { content: [{ type: "tool_result", content: "exit 0, 12 files" }] } },
      ],
    };

    const state = await runRepoAgent(opts());

    expect(texts(state, "tool_call")).toContain("→ exit 0, 12 files");
  });

  it("flattens a block-array tool result into one line", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = {
      code: 0,
      lines: [
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] },
            ],
          },
        },
      ],
    };

    const state = await runRepoAgent(opts());

    expect(texts(state, "tool_call")).toContain("→ part1 part2");
  });

  it("classifies a failed tool result as an error", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = {
      code: 0,
      lines: [
        {
          type: "user",
          message: { content: [{ type: "tool_result", content: "boom", is_error: true }] },
        },
      ],
    };

    const state = await runRepoAgent(opts());

    expect(texts(state, "error")).toContain("→ boom");
  });

  it("truncates a long tool result to keep the transcript readable", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = {
      code: 0,
      lines: [
        { type: "user", message: { content: [{ type: "tool_result", content: "y".repeat(400) }] } },
      ],
    };

    const state = await runRepoAgent(opts());

    const evt = texts(state, "tool_call").find((t) => t.startsWith("→ y"))!;
    expect(evt).toBe(`→ ${"y".repeat(300)}…`);
  });

  it("reports MCP server status and exposed tools from the init event", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = {
      code: 0,
      lines: [
        {
          type: "system",
          subtype: "init",
          mcp_servers: [{ name: "beevibe-sandbox", status: "connected" }],
          tools: ["Glob", "mcp__beevibe-sandbox__sandbox_exec"],
        },
      ],
    };

    const state = await runRepoAgent(opts());

    const logs = texts(state, "log");
    expect(logs).toContain("mcp server beevibe-sandbox: connected");
    // Non-sandbox tools are filtered out so a connection failure is obvious.
    expect(logs).toContain("mcp tools exposed: mcp__beevibe-sandbox__sandbox_exec");
  });

  it("says so explicitly when the init event exposes no sandbox tools", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = {
      code: 0,
      lines: [
        { type: "system", subtype: "init", mcp_servers: [{ name: "beevibe-sandbox", status: "failed" }], tools: ["Glob"] },
      ],
    };

    const state = await runRepoAgent(opts());

    expect(texts(state, "log")).toContain("mcp tools exposed: none");
  });

  it("surfaces a result event and a top-level error event", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = {
      code: 0,
      lines: [
        { type: "error", message: "rate limited" },
        { type: "result", result: "Exported tables.csv." },
      ],
    };

    const state = await runRepoAgent(opts());

    expect(texts(state, "error")).toContain("rate limited");
    expect(texts(state, "agent")).toContain("Exported tables.csv.");
  });

  it("ignores non-JSON noise on stdout", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = { code: 0, rawChunks: ["warning: something\n\n"] };

    const state = await runRepoAgent(opts());

    // Noise must not crash the parser or leak into the transcript.
    expect(state.status).toBe("succeeded");
    expect(texts(state)).not.toContain("warning: something");
  });

  it("buffers a stream-json object split across two chunks", async () => {
    await placeArtifact("out.txt", "x");
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "split-message" }] },
    });
    claudeScript = {
      code: 0,
      rawChunks: [line.slice(0, 20), line.slice(20) + "\n"],
    };

    const state = await runRepoAgent(opts());

    expect(texts(state, "agent")).toContain("split-message");
  });
});

/* ─────────── RunState bounding ─────────── */

describe("runRepoAgent — bounded run state", () => {
  it("truncates a single oversized event", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = {
      code: 0,
      lines: [{ type: "assistant", message: { content: [{ type: "text", text: "q".repeat(9000) }] } }],
    };

    const state = await runRepoAgent(opts());

    const evt = texts(state, "agent").find((t) => t.startsWith("q"))!;
    expect(evt).toContain("…[truncated 5000 bytes]…");
    expect(evt.length).toBeLessThan(4_100);
  });

  it("caps the transcript and marks that earlier events were dropped", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = {
      code: 0,
      lines: Array.from({ length: 600 }, (_, i) => ({
        type: "assistant",
        message: { content: [{ type: "text", text: `msg-${i}` }] },
      })),
    };

    const state = await runRepoAgent(opts());

    // 500 events is the cap that keeps a RunState payload under ~2MB;
    // the injected truncation notice occupies one slot above it.
    expect(state.transcript).toHaveLength(501);
    // The first event is kept as an anchor; the truncation notice sits next to it.
    expect(state.transcript[0]!.text).toBe("Creating sandbox container…");
    expect(state.transcript[1]!.text).toMatch(/^\[log truncated: dropped \d+ earlier events?\]$/);
    // The newest events survive — that's what a reader needs.
    expect(texts(state, "agent")).toContain("msg-599");
    expect(texts(state, "agent")).not.toContain("msg-0");
  });

  it("keeps exactly one truncation notice no matter how far it overflows", async () => {
    await placeArtifact("out.txt", "x");
    claudeScript = {
      code: 0,
      lines: Array.from({ length: 900 }, (_, i) => ({
        type: "assistant",
        message: { content: [{ type: "text", text: `m${i}` }] },
      })),
    };

    const state = await runRepoAgent(opts());

    const notices = texts(state).filter((t) => t.startsWith("[log truncated:"));
    expect(notices).toHaveLength(1);
  });
});

/* ─────────── state emission + teardown ─────────── */

describe("runRepoAgent — state emission and teardown", () => {
  it("emits progressively and ends on the returned state", async () => {
    await placeArtifact("out.txt", "x");
    const seen: RunState[] = [];

    const state = await runRepoAgent(opts({ on_state: (s) => seen.push(s) }));

    expect(seen.length).toBeGreaterThan(3);
    expect(seen.map((s) => s.status)).toContain("preparing");
    expect(seen.map((s) => s.status)).toContain("running");
    expect(seen.at(-1)!.status).toBe(state.status);
  });

  it("hands each callback its own transcript copy", async () => {
    await placeArtifact("out.txt", "x");
    const snapshots: number[] = [];

    await runRepoAgent(opts({ on_state: (s) => snapshots.push(s.transcript.length) }));

    // A snapshot must not keep growing after it was handed over, or a
    // consumer diffing states sees nothing change.
    expect(snapshots).toEqual([...snapshots].sort((a, b) => a - b));
    expect(new Set(snapshots).size).toBeGreaterThan(1);
  });

  it("tears the sandbox down even when the run fails", async () => {
    claudeScript = { code: 1, stderr: "nope" };

    await runRepoAgent(opts());

    expect(docker.destroySandbox).toHaveBeenCalledOnce();
  });

  it("keeps a successful outcome when teardown fails", async () => {
    await placeArtifact("out.txt", "x");
    docker.destroySandbox.mockRejectedValue(new Error("container is locked"));

    const state = await runRepoAgent(opts());

    // Cleanup is best-effort; it must not turn a good run into a failure.
    expect(state.status).toBe("succeeded");
    expect(texts(state, "log").join("\n")).toMatch(/Sandbox cleanup note: container is locked/);
  });

  it("records the run's identity and timing on the returned state", async () => {
    await placeArtifact("out.txt", "x");

    const state = await runRepoAgent(opts());

    expect(state.run_id).toBe("run-1");
    expect(state.repo_url).toBe("https://github.com/jsvine/pdfplumber");
    expect(state.goal).toBe("extract the tables");
    expect(Date.parse(state.started_at)).not.toBeNaN();
    expect(Date.parse(state.finished_at!)).toBeGreaterThanOrEqual(Date.parse(state.started_at));
  });
});
