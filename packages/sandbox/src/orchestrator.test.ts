/**
 * Unit tests for `runRepoAgent` — the full "agent borrows an external
 * repo inside a sandbox" run loop.
 *
 * Both edges are mocked: `./docker.js` (covered by `docker.test.ts`) and
 * the `claude` child process. The child is driven by feeding it real
 * stream-json lines, which is the only way to exercise the transcript
 * translation and the run's terminal-status logic without a live CLI.
 *
 * What's worth pinning here is the state machine: which statuses a run
 * can end in, that the sandbox is always torn down, and that the
 * transcript stays bounded no matter how noisy the child is.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("./docker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./docker.js")>();
  return {
    ...actual,
    createSandbox: vi.fn(),
    destroySandbox: vi.fn(),
    exec: vi.fn(),
    prepareBaseEnvironment: vi.fn(),
  };
});

import type { Sandbox } from "./docker.js";

const { spawn } = await import("node:child_process");
const docker = await import("./docker.js");
const { runRepoAgent } = await import("./orchestrator.js");
type RunState = Awaited<ReturnType<typeof runRepoAgent>>;

let artifactDir: string;
let sandbox: Sandbox;

/** Handle on the fake `claude` child so a test can drive it. */
interface FakeClaude {
  stdout: EventEmitter;
  stderr: EventEmitter;
  proc: EventEmitter & Record<string, unknown>;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  argv: string[];
}
let claude: FakeClaude;

/**
 * What the fake `claude` does once spawned. Defaults to a clean exit so a
 * test only has to describe the behaviour it actually cares about.
 */
let claudeBehaviour: (c: FakeClaude) => void = (c) => c.proc.emit("close", 0);

/** The value following `flag` in the spawned `claude` argv. */
function claudeFlag(flag: string): string {
  const i = claude.argv.indexOf(flag);
  if (i === -1) throw new Error(`claude was not passed ${flag}`);
  const v = claude.argv[i + 1];
  if (v === undefined) throw new Error(`${flag} was passed with no value`);
  return v;
}

/** The shell command of the Nth `docker exec` the orchestrator issued. */
function execCmd(n: number): string {
  const call = vi.mocked(docker.exec).mock.calls[n];
  if (!call) throw new Error(`expected at least ${n + 1} exec call(s)`);
  return call[1];
}

/** The prompt the orchestrator piped to the child over stdin. */
function stdinPrompt(): string {
  const call = claude.stdin.write.mock.calls[0];
  if (!call) throw new Error("nothing was written to the child's stdin");
  return call[0] as string;
}

function emitLines(c: FakeClaude, ...events: unknown[]): void {
  for (const e of events) {
    c.stdout.emit("data", Buffer.from(JSON.stringify(e) + "\n", "utf8"));
  }
}

beforeEach(async () => {
  artifactDir = await mkdtemp(join(tmpdir(), "bv-orch-test-"));
  sandbox = {
    id: "bv-run-test-abc",
    image: "python:3.12-slim",
    artifact_dir: artifactDir,
    created_at: new Date("2026-01-01T00:00:00Z"),
  };

  vi.mocked(docker.createSandbox).mockResolvedValue(sandbox);
  vi.mocked(docker.prepareBaseEnvironment).mockResolvedValue(undefined);
  vi.mocked(docker.destroySandbox).mockResolvedValue(undefined);
  vi.mocked(docker.exec).mockResolvedValue({
    stdout: "",
    stderr: "",
    exit_code: 0,
    timed_out: false,
    duration_seconds: 0.1,
  });

  claudeBehaviour = (c) => c.proc.emit("close", 0);

  vi.mocked(spawn).mockImplementation(((_bin: string, args: string[]) => {
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.unref = vi.fn();
    proc.kill = vi.fn(() => {
      setImmediate(() => proc.emit("close", null));
    });
    claude = {
      stdout,
      stderr,
      proc,
      stdin: proc.stdin as FakeClaude["stdin"],
      argv: args,
    };
    setImmediate(() => claudeBehaviour(claude));
    return proc;
  }) as unknown as typeof spawn);
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers();
  await rm(artifactDir, { recursive: true, force: true });
});

/** Put an exported artifact (plus optional sidecar) in the artifact dir. */
async function placeArtifact(
  name: string,
  body: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(artifactDir, name), body, "utf8");
  if (meta) {
    await writeFile(join(artifactDir, `${name}.meta.json`), JSON.stringify(meta), "utf8");
  }
}

const baseOpts = {
  run_id: "run-1",
  repo_url: "https://github.com/acme/tool",
  goal: "extract the tables",
};

describe("runRepoAgent — successful run", () => {
  it("succeeds and collects the exported artifact", async () => {
    claudeBehaviour = async (c) => {
      await placeArtifact("tables.csv", "a,b\n1,2\n", {
        title: "Extracted tables",
        sandbox_path: "/sandbox/artifacts/tables.csv",
      });
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

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
    expect(state.sandbox_id).toBe(sandbox.id);
  });

  it("prepares the base image before spawning the agent", async () => {
    await runRepoAgent(baseOpts);

    expect(docker.createSandbox).toHaveBeenCalledWith({ label: "bv-run-run-1" });
    expect(docker.prepareBaseEnvironment).toHaveBeenCalledWith(sandbox);
  });

  it("always tears the sandbox down", async () => {
    await runRepoAgent(baseOpts);

    expect(docker.destroySandbox).toHaveBeenCalledWith(sandbox);
  });

  it("writes an MCP config pointing the child at this sandbox", async () => {
    await runRepoAgent(baseOpts);

    const cfg = JSON.parse(await readFile(join(artifactDir, "mcp-config.json"), "utf8"));
    expect(cfg.mcpServers["beevibe-sandbox"].env).toEqual({
      BEEVIBE_SANDBOX_ID: sandbox.id,
      BEEVIBE_SANDBOX_ARTIFACTS: artifactDir,
    });
  });

  it("honours a caller-supplied MCP server command", async () => {
    await runRepoAgent({
      ...baseOpts,
      mcp_server_command: { command: "node", args: ["/custom/mcp.js"] },
    });

    const cfg = JSON.parse(await readFile(join(artifactDir, "mcp-config.json"), "utf8"));
    expect(cfg.mcpServers["beevibe-sandbox"]).toMatchObject({
      command: "node",
      args: ["/custom/mcp.js"],
    });
  });
});

describe("runRepoAgent — child CLI invocation", () => {
  it("locks the child to the sandbox tools and disables host file/shell tools", async () => {
    await runRepoAgent(baseOpts);

    const allowed = claudeFlag("--allowed-tools").split(",");
    expect(allowed).toEqual([
      "mcp__beevibe-sandbox__sandbox_exec",
      "mcp__beevibe-sandbox__sandbox_read_file",
      "mcp__beevibe-sandbox__sandbox_write_file",
      "mcp__beevibe-sandbox__sandbox_list",
      "mcp__beevibe-sandbox__sandbox_export_artifact",
    ]);
    const disallowed = claudeFlag("--disallowed-tools").split(",");
    expect(disallowed).toEqual(["Bash", "Read", "Edit", "Write", "BashOutput", "KillBash"]);
  });

  it("applies the default budget and passes the run's MCP config", async () => {
    await runRepoAgent(baseOpts);

    expect(claudeFlag("--max-budget-usd")).toBe("2");
    expect(claudeFlag("--mcp-config")).toBe(join(artifactDir, "mcp-config.json"));
    expect(claude.argv).toContain("--print");
    expect(claude.argv).toContain("stream-json");
  });

  it("passes an overridden budget through", async () => {
    await runRepoAgent({ ...baseOpts, max_budget_usd: 10 });

    expect(claudeFlag("--max-budget-usd")).toBe("10");
  });

  it("uses the configured claude binary", async () => {
    await runRepoAgent({ ...baseOpts, claude_bin: "/opt/bin/claude" });

    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe("/opt/bin/claude");
  });

  it("pipes the goal and repo to the child over stdin", async () => {
    await runRepoAgent(baseOpts);

    const prompt = stdinPrompt();
    expect(prompt).toContain("Goal: extract the tables");
    expect(prompt).toContain("Repo: https://github.com/acme/tool");
    expect(claude.stdin.end).toHaveBeenCalled();
  });
});

describe("runRepoAgent — input pre-fetch", () => {
  it("curls the input into the sandbox and tells the agent where it landed", async () => {
    await runRepoAgent({
      ...baseOpts,
      input_url: "https://example.com/doc.pdf",
      input_filename: "doc.pdf",
    });

    const cmd = execCmd(0);
    expect(cmd).toContain("mkdir -p /sandbox/inputs");
    expect(cmd).toContain("curl -fsSL 'https://example.com/doc.pdf' -o /sandbox/inputs/'doc.pdf'");

    const prompt = stdinPrompt();
    expect(prompt).toContain("Input file (pre-fetched): /sandbox/inputs/doc.pdf");
  });

  it("quotes the input URL so it can't break out of the shell command", async () => {
    await runRepoAgent({
      ...baseOpts,
      input_url: "https://example.com/a'; rm -rf /; echo '",
    });

    const cmd = execCmd(0);
    expect(cmd).toContain(`'https://example.com/a'\\''; rm -rf /; echo '\\'''`);
  });

  it("defaults the input filename to input.bin", async () => {
    await runRepoAgent({ ...baseOpts, input_url: "https://example.com/x" });

    expect(execCmd(0)).toContain("/sandbox/inputs/'input.bin'");
  });

  it("fails the run when the input fetch fails, without spawning the agent", async () => {
    vi.mocked(docker.exec).mockResolvedValue({
      stdout: "",
      stderr: "curl: (22) 404\n",
      exit_code: 22,
      timed_out: false,
      duration_seconds: 0.2,
    });

    const state = await runRepoAgent({ ...baseOpts, input_url: "https://example.com/gone" });

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/input fetch failed: curl: \(22\) 404/);
    expect(spawn).not.toHaveBeenCalled();
    expect(docker.destroySandbox).toHaveBeenCalled();
  });
});

describe("runRepoAgent — terminal statuses", () => {
  it("is blocked, not succeeded, when the agent exports nothing", async () => {
    const state = await runRepoAgent(baseOpts);

    expect(state.status).toBe("blocked");
    expect(state.error).toBe("agent produced no artifacts");
    expect(state.artifacts).toEqual([]);
  });

  it("fails with the stderr tail when the child exits non-zero", async () => {
    claudeBehaviour = (c) => {
      c.stderr.emit("data", Buffer.from("auth error: invalid API key\n", "utf8"));
      c.proc.emit("close", 1);
    };

    const state = await runRepoAgent(baseOpts);

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/Claude exited 1\./);
    expect(state.error).toContain("auth error: invalid API key");
  });

  it("is blocked when the run hits its wall-clock budget", async () => {
    // Real timers with a tiny budget rather than fake ones: the run does
    // real file I/O (the MCP config) before it spawns the child, and fake
    // timers don't advance past that, so the timeout would never arm.
    claudeBehaviour = () => {
      /* never exits on its own — the timeout must kill it */
    };

    const state = await runRepoAgent({ ...baseOpts, max_runtime_seconds: 0.05 });

    expect(state.status).toBe("blocked");
    expect(state.error).toMatch(/hit the 0\.05s wall-clock budget/);
    expect(claude.proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("reports a missing claude binary as an actionable error", async () => {
    claudeBehaviour = (c) => c.proc.emit("error", new Error("spawn claude ENOENT"));

    const state = await runRepoAgent(baseOpts);

    expect(state.status).toBe("failed");
    expect(
      state.transcript.some((e) => e.text.includes("Set BEEVIBE_CLAUDE_BIN")),
    ).toBe(true);
  });

  it("rewrites a stopped Docker daemon into a human instruction", async () => {
    vi.mocked(docker.createSandbox).mockRejectedValue(
      new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"),
    );

    const state = await runRepoAgent(baseOpts);

    expect(state.status).toBe("failed");
    expect(state.error).toBe("Docker isn't running. Start Docker Desktop and try the run again.");
    // Nothing to tear down when creation never succeeded.
    expect(docker.destroySandbox).not.toHaveBeenCalled();
  });

  it("rewrites a missing docker CLI and a full disk", async () => {
    vi.mocked(docker.createSandbox).mockRejectedValue(new Error("spawn docker ENOENT"));
    expect((await runRepoAgent(baseOpts)).error).toMatch(/docker` CLI isn't on PATH/);

    vi.mocked(docker.createSandbox).mockRejectedValue(
      new Error("no space left on device"),
    );
    expect((await runRepoAgent(baseOpts)).error).toMatch(/Docker is out of disk/);
  });

  it("passes an unrecognized startup error through unchanged", async () => {
    vi.mocked(docker.createSandbox).mockRejectedValue(new Error("something odd"));

    expect((await runRepoAgent(baseOpts)).error).toBe("something odd");
  });

  it("fails the run when base preparation fails", async () => {
    vi.mocked(docker.prepareBaseEnvironment).mockRejectedValue(
      new docker.SandboxError("base prep failed (exit 100)"),
    );

    const state = await runRepoAgent(baseOpts);

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/base prep failed/);
    expect(docker.destroySandbox).toHaveBeenCalled();
  });

  it("keeps a successful outcome when teardown fails", async () => {
    vi.mocked(docker.destroySandbox).mockRejectedValue(new Error("container already gone"));
    claudeBehaviour = async (c) => {
      await placeArtifact("out.txt", "done");
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

    expect(state.status).toBe("succeeded");
    expect(
      state.transcript.some((e) => e.text.includes("Sandbox cleanup note")),
    ).toBe(true);
  });
});

describe("runRepoAgent — transcript", () => {
  it("surfaces assistant text and tool calls from the stream", async () => {
    claudeBehaviour = (c) => {
      emitLines(
        c,
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Cloning the repo." },
              {
                type: "tool_use",
                name: "mcp__beevibe-sandbox__sandbox_exec",
                input: { cmd: "git clone https://github.com/acme/tool" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", content: "Cloning into 'tool'..." }],
          },
        },
      );
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

    const agentText = state.transcript.filter((e) => e.kind === "agent").map((e) => e.text);
    expect(agentText).toContain("Cloning the repo.");

    const toolCalls = state.transcript.filter((e) => e.kind === "tool_call").map((e) => e.text);
    expect(toolCalls).toContain(
      'mcp__beevibe-sandbox__sandbox_exec({"cmd":"git clone https://github.com/acme/tool"})',
    );
    expect(toolCalls.some((t) => t.startsWith("→ Cloning into 'tool'"))).toBe(true);
  });

  it("marks an errored tool result as an error event", async () => {
    claudeBehaviour = (c) => {
      emitLines(c, {
        type: "user",
        message: {
          content: [
            { type: "tool_result", is_error: true, content: "exit 1: no such file" },
          ],
        },
      });
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

    expect(
      state.transcript.some((e) => e.kind === "error" && e.text.includes("no such file")),
    ).toBe(true);
  });

  it("flattens a structured tool_result into text", async () => {
    claudeBehaviour = (c) => {
      emitLines(c, {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: [
                { type: "text", text: "part one" },
                { type: "text", text: "part two" },
              ],
            },
          ],
        },
      });
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

    expect(state.transcript.some((e) => e.text.includes("part one part two"))).toBe(true);
  });

  it("reports MCP server status and the exposed sandbox tools on init", async () => {
    claudeBehaviour = (c) => {
      emitLines(c, {
        type: "system",
        subtype: "init",
        mcp_servers: [{ name: "beevibe-sandbox", status: "connected" }],
        tools: ["Bash", "mcp__beevibe-sandbox__sandbox_exec"],
      });
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);
    const texts = state.transcript.map((e) => e.text);

    expect(texts).toContain("mcp server beevibe-sandbox: connected");
    expect(texts).toContain("mcp tools exposed: mcp__beevibe-sandbox__sandbox_exec");
  });

  it("says so explicitly when init exposes no sandbox tools", async () => {
    claudeBehaviour = (c) => {
      emitLines(c, { type: "system", subtype: "init", tools: ["Bash"] });
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

    expect(state.transcript.map((e) => e.text)).toContain("mcp tools exposed: none");
  });

  it("handles a JSON object split across two stdout chunks", async () => {
    claudeBehaviour = (c) => {
      const line = JSON.stringify({ type: "result", result: "all done" }) + "\n";
      c.stdout.emit("data", Buffer.from(line.slice(0, 12), "utf8"));
      c.stdout.emit("data", Buffer.from(line.slice(12), "utf8"));
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

    expect(state.transcript.some((e) => e.text === "all done")).toBe(true);
  });

  it("ignores non-JSON noise lines without failing the run", async () => {
    claudeBehaviour = (c) => {
      c.stdout.emit("data", Buffer.from("warning: something\n\n", "utf8"));
      emitLines(c, { type: "result", result: "fine" });
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

    expect(state.transcript.some((e) => e.text === "fine")).toBe(true);
    expect(state.transcript.some((e) => e.text.includes("warning: something"))).toBe(false);
  });

  it("truncates an oversized event instead of storing it whole", async () => {
    claudeBehaviour = (c) => {
      emitLines(c, { type: "result", result: "x".repeat(10_000) });
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

    const big = state.transcript.find((e) => e.text.startsWith("xxx"));
    expect(big?.text).toContain("[truncated 6000 bytes]");
    expect(big?.text.length).toBeLessThan(4_100);
  });

  it("caps the transcript and notes how many events were dropped", async () => {
    claudeBehaviour = (c) => {
      for (let i = 0; i < 600; i++) {
        emitLines(c, { type: "result", result: `event ${i}` });
      }
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

    // Bounded at the 500-event cap plus the injected truncation notice —
    // trimming happens before the notice is re-inserted, so the steady
    // state sits one over. The point of the cap is a bounded payload, and
    // 501 events of <=4KB stays far under that.
    expect(state.transcript.length).toBeLessThanOrEqual(501);
    // The first event is preserved as an anchor, with the truncation
    // notice right behind it.
    expect(state.transcript[0]!.text).toBe("Creating sandbox container…");
    expect(state.transcript[1]!.text).toMatch(/^\[log truncated: dropped \d+ earlier events?\]$/);
    // The notice is inserted once, not once per dropped event.
    expect(state.transcript.filter((e) => e.text.startsWith("[log truncated:"))).toHaveLength(1);
    // Recent events survive.
    expect(state.transcript.some((e) => e.text === "event 599")).toBe(true);
  });

  it("emits state to on_state as the run progresses", async () => {
    const seen: RunState[] = [];

    const final = await runRepoAgent({ ...baseOpts, on_state: (s) => seen.push(s) });

    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]!.status).toBe("starting");
    expect(seen.map((s) => s.status)).toContain("running");
    expect(seen.at(-1)?.status).toBe(final.status);
    // Callers get a copy — mutating it must not corrupt the run's state.
    seen[0]!.transcript.push({ at: "x", kind: "log", text: "injected" });
    expect(final.transcript.some((e) => e.text === "injected")).toBe(false);
  });
});

describe("runRepoAgent — artifact collection", () => {
  it("falls back to the filename stem when a sidecar is missing", async () => {
    claudeBehaviour = async (c) => {
      await placeArtifact("summary.md", "# hi");
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0]).toMatchObject({
      filename: "summary.md",
      title: "summary",
      sandbox_path: undefined,
    });
  });

  it("skips the MCP config and the sidecars themselves", async () => {
    claudeBehaviour = async (c) => {
      await placeArtifact("real.txt", "x", { title: "Real" });
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

    expect(state.artifacts.map((a) => a.filename)).toEqual(["real.txt"]);
  });

  it("ignores an unparseable sidecar and keeps the artifact", async () => {
    claudeBehaviour = async (c) => {
      await writeFile(join(artifactDir, "out.bin"), "data", "utf8");
      await writeFile(join(artifactDir, "out.bin.meta.json"), "{not json", "utf8");
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0]!.title).toBe("out");
  });

  it("collects several artifacts at once", async () => {
    claudeBehaviour = async (c) => {
      await placeArtifact("a.csv", "1", { title: "A" });
      await placeArtifact("b.csv", "22", { title: "B" });
      c.proc.emit("close", 0);
    };

    const state = await runRepoAgent(baseOpts);

    expect(state.artifacts.map((a) => [a.title, a.size_bytes]).sort()).toEqual([
      ["A", 1],
      ["B", 2],
    ]);
  });
});
