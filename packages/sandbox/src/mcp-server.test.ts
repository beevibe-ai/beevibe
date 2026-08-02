/**
 * Integration tests for the sandbox MCP server.
 *
 * This is the surface the child agent actually drives — the five tools
 * are the only way it can touch the container, so their argument
 * validation and error mapping are part of the trust boundary. It had
 * no coverage at all.
 *
 * Rather than reach inside the module (everything but `main` is
 * private, and importing it would start a stdio server), we run the
 * real entrypoint as a subprocess and speak MCP to it over stdio — the
 * same way the claude CLI does. A stub `docker` executable earlier on
 * PATH stands in for the daemon, so these need no Docker.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "mcp-server.ts");

/** Where the stub docker records the argv it was called with. */
let callLog: string;
let stubDir: string;
let artifactDir: string;
const tempDirs: string[] = [];

/**
 * A stand-in `docker` that logs its argv and behaves per a JSON script.
 * The script maps a regex over the joined argv to {code, stdout, stderr},
 * letting each test decide how the "daemon" responds.
 */
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.BV_CALL_LOG, JSON.stringify(argv) + "\\n");
const script = JSON.parse(fs.readFileSync(process.env.BV_SCRIPT, "utf8"));
const joined = argv.join(" ");
for (const rule of script) {
  if (!new RegExp(rule.match).test(joined)) continue;
  // \`docker cp\` is expected to materialize the file on the host.
  if (rule.writeArg !== undefined) fs.writeFileSync(argv[rule.writeArg], rule.writeContent ?? "");
  if (rule.stdout) process.stdout.write(rule.stdout);
  if (rule.stderr) process.stderr.write(rule.stderr);
  process.exit(rule.code ?? 0);
}
process.exit(0);
`;

interface Rule {
  match: string;
  code?: number;
  stdout?: string;
  stderr?: string;
  writeArg?: number;
  writeContent?: string;
}

let scriptPath: string;

async function setScript(rules: Rule[]): Promise<void> {
  await writeFile(scriptPath, JSON.stringify(rules), "utf8");
}

/** Every argv the stub docker saw, in order. */
async function dockerCalls(): Promise<string[][]> {
  const raw = await readFile(callLog, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
}

let client: Client;
let transport: StdioClientTransport;

/** Connect a fresh MCP client to a server bound to `artifactDir`. */
async function connect(env: Record<string, string> = {}): Promise<Client> {
  transport = new StdioClientTransport({
    command: "npx",
    args: ["--no-install", "tsx", SERVER],
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      BV_CALL_LOG: callLog,
      BV_SCRIPT: scriptPath,
      BEEVIBE_SANDBOX_ID: "bv-test-container",
      BEEVIBE_SANDBOX_ARTIFACTS: artifactDir,
      ...env,
    } as Record<string, string>,
    stderr: "ignore",
  });
  const c = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await c.connect(transport);
  return c;
}

/**
 * The first text block of a tool result. `callTool` is typed as a union
 * of the modern and legacy result shapes, so narrow here once rather
 * than at every call site.
 */
function textOf(res: unknown): string {
  const blocks = (res as { content: { type: string; text: string }[] }).content;
  return blocks[0]!.text;
}

/** The tool's JSON payload, parsed back out of the MCP text block. */
function payload(res: unknown): Record<string, unknown> {
  return JSON.parse(textOf(res)) as Record<string, unknown>;
}

// One server process for the whole file: spawning `tsx` per test cost
// ~800ms each. The stub reads its script and call log fresh on every
// invocation, so per-test isolation only needs those two files reset.
beforeAll(async () => {
  stubDir = await mkdtemp(join(tmpdir(), "bv-stub-"));
  artifactDir = await mkdtemp(join(tmpdir(), "bv-mcp-artifacts-"));
  tempDirs.push(stubDir, artifactDir);

  const stubPath = join(stubDir, "docker");
  await writeFile(stubPath, STUB, "utf8");
  await chmod(stubPath, 0o755);
  scriptPath = join(stubDir, "script.json");
  callLog = join(stubDir, "calls.jsonl");
  await setScript([{ match: ".*", code: 0 }]);

  client = await connect();
});

beforeEach(async () => {
  await writeFile(callLog, "", "utf8");
  await setScript([{ match: ".*", code: 0 }]);
});

afterAll(async () => {
  await transport?.close().catch(() => {});
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/* ─────────── tool listing ─────────── */

describe("tool listing", () => {
  it("advertises exactly the five sandbox tools", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "sandbox_exec",
      "sandbox_export_artifact",
      "sandbox_list",
      "sandbox_read_file",
      "sandbox_write_file",
    ]);
  });

  it("declares the required arguments for each tool", async () => {
    const { tools } = await client.listTools();
    const required = Object.fromEntries(
      tools.map((t) => [t.name, (t.inputSchema as { required?: string[] }).required ?? []]),
    );

    expect(required).toEqual({
      sandbox_exec: ["cmd"],
      sandbox_read_file: ["path"],
      sandbox_write_file: ["path", "content"],
      sandbox_list: ["path"],
      sandbox_export_artifact: ["sandbox_path"],
    });
  });

  it("describes every tool so the agent knows when to reach for it", async () => {
    const { tools } = await client.listTools();

    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(40);
    }
  });
});

/* ─────────── sandbox_exec ─────────── */

describe("sandbox_exec", () => {
  it("runs the command in the bound container and returns the result", async () => {
    await setScript([{ match: "exec", code: 0, stdout: "hello\n" }]);
    const res = await client.callTool({ name: "sandbox_exec", arguments: { cmd: "echo hello" } });

    expect(payload(res)).toMatchObject({ stdout: "hello\n", exit_code: 0, timed_out: false });
    const call = (await dockerCalls())[0]!;
    expect(call.slice(0, 3)).toEqual(["exec", "--workdir", "/sandbox"]);
    // The server is bound to one container by env; the agent can't retarget it.
    expect(call).toContain("bv-test-container");
    expect(call.at(-1)).toBe("echo hello");
  });

  it("passes an explicit cwd through", async () => {
    await client.callTool({
      name: "sandbox_exec",
      arguments: { cmd: "ls", cwd: "/sandbox/repo" },
    });

    const call = (await dockerCalls())[0]!;
    expect(call[call.indexOf("--workdir") + 1]).toBe("/sandbox/repo");
  });

  it("reports a non-zero exit as data rather than an error", async () => {
    await setScript([{ match: "exec", code: 3, stderr: "bad things\n" }]);
    const res = await client.callTool({ name: "sandbox_exec", arguments: { cmd: "false" } });

    // The agent needs to see the failure and decide, not get a protocol error.
    expect(res.isError).toBeFalsy();
    expect(payload(res)).toMatchObject({ exit_code: 3, stderr: "bad things\n" });
  });

  it("caps a flood of stdout so one command can't blow the context", async () => {
    await setScript([{ match: "exec", code: 0, stdout: "z".repeat(70_000) }]);
    const res = await client.callTool({ name: "sandbox_exec", arguments: { cmd: "cat big" } });

    const out = payload(res).stdout as string;
    expect(out).toContain("…[truncated 6000 bytes]…");
    expect(out.length).toBeLessThan(64_100);
  });

  it("rejects a missing cmd", async () => {
    const res = await client.callTool({ name: "sandbox_exec", arguments: {} });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('missing or invalid "cmd"');
  });

  it("rejects a non-string cmd", async () => {
    const res = await client.callTool({ name: "sandbox_exec", arguments: { cmd: 42 } });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('missing or invalid "cmd"');
  });

  it("rejects a non-number timeout_seconds", async () => {
    const res = await client.callTool({
      name: "sandbox_exec",
      arguments: { cmd: "ls", timeout_seconds: "30" },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('invalid "timeout_seconds" (number expected)');
  });

  it("treats a null optional as absent rather than invalid", async () => {
    const res = await client.callTool({
      name: "sandbox_exec",
      arguments: { cmd: "ls", cwd: null, timeout_seconds: null },
    });

    expect(res.isError).toBeFalsy();
    const call = (await dockerCalls())[0]!;
    expect(call[call.indexOf("--workdir") + 1]).toBe("/sandbox");
  });
});

/* ─────────── sandbox_read_file ─────────── */

describe("sandbox_read_file", () => {
  it("returns the file contents", async () => {
    await setScript([{ match: "head -c", code: 0, stdout: "# README\n" }]);
    const res = await client.callTool({
      name: "sandbox_read_file",
      arguments: { path: "/sandbox/repo/README.md" },
    });

    expect(payload(res)).toEqual({ content: "# README\n" });
  });

  it("maps a missing file to an isError result the agent can react to", async () => {
    await setScript([{ match: "head -c", code: 1, stderr: "No such file or directory" }]);
    const res = await client.callTool({
      name: "sandbox_read_file",
      arguments: { path: "/sandbox/nope" },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/error: read \/sandbox\/nope failed/);
  });

  it("honours max_bytes", async () => {
    await setScript([{ match: "head -c", code: 0, stdout: "abc" }]);
    await client.callTool({
      name: "sandbox_read_file",
      arguments: { path: "/sandbox/x", max_bytes: 64 },
    });

    expect((await dockerCalls())[0]!.at(-1)).toBe("head -c 65 '/sandbox/x'");
  });

  it("errors rather than silently truncating past max_bytes", async () => {
    await setScript([{ match: "head -c", code: 0, stdout: "x".repeat(11) }]);
    const res = await client.callTool({
      name: "sandbox_read_file",
      arguments: { path: "/sandbox/big", max_bytes: 10 },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("exceeded max_bytes=10");
  });

  it("rejects a missing path", async () => {
    const res = await client.callTool({ name: "sandbox_read_file", arguments: {} });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('missing or invalid "path"');
  });
});

/* ─────────── sandbox_write_file ─────────── */

describe("sandbox_write_file", () => {
  it("writes through the staging bind and reports success", async () => {
    const res = await client.callTool({
      name: "sandbox_write_file",
      arguments: { path: "/sandbox/glue.py", content: "print(1)" },
    });

    expect(payload(res)).toEqual({ ok: true });
    const cmds = (await dockerCalls()).map((c) => c.at(-1)!);
    expect(cmds[0]).toBe("mkdir -p '/sandbox'");
    expect(cmds[1]).toMatch(/^mv '\/sandbox\/artifacts\/__stage_[0-9a-f]+' '\/sandbox\/glue\.py'$/);
  });

  it("reports a failed write as an error", async () => {
    await setScript([
      { match: "mkdir", code: 0 },
      { match: "mv", code: 1, stderr: "Read-only file system" },
    ]);
    const res = await client.callTool({
      name: "sandbox_write_file",
      arguments: { path: "/sandbox/out.txt", content: "x" },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/write \/sandbox\/out.txt failed/);
  });

  it("rejects a non-string content", async () => {
    const res = await client.callTool({
      name: "sandbox_write_file",
      arguments: { path: "/sandbox/x", content: { a: 1 } },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('missing or invalid "content"');
  });
});

/* ─────────── sandbox_list ─────────── */

describe("sandbox_list", () => {
  it("returns directory entries", async () => {
    await setScript([{ match: "ls -1", code: 0, stdout: "a.py\nb.py\n" }]);
    const res = await client.callTool({
      name: "sandbox_list",
      arguments: { path: "/sandbox/repo" },
    });

    expect(payload(res)).toEqual({ entries: ["a.py", "b.py"] });
  });

  it("maps a missing directory to an error", async () => {
    await setScript([{ match: "ls -1", code: 2, stderr: "No such file or directory" }]);
    const res = await client.callTool({ name: "sandbox_list", arguments: { path: "/nope" } });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/list \/nope failed/);
  });
});

/* ─────────── sandbox_export_artifact ─────────── */

describe("sandbox_export_artifact", () => {
  it("copies the file out and returns a host descriptor", async () => {
    await setScript([{ match: "^cp", code: 0, writeArg: 2, writeContent: "csv,data\n" }]);
    const res = await client.callTool({
      name: "sandbox_export_artifact",
      arguments: { sandbox_path: "/sandbox/artifacts/out.csv", title: "Extracted rows" },
    });

    expect(payload(res)).toEqual({
      host_path: join(artifactDir, "out.csv"),
      size_bytes: 9,
      title: "Extracted rows",
    });
  });

  it("writes the sidecar the orchestrator reads titles back from", async () => {
    await setScript([{ match: "^cp", code: 0, writeArg: 2, writeContent: "x" }]);
    await client.callTool({
      name: "sandbox_export_artifact",
      arguments: { sandbox_path: "/sandbox/artifacts/report.pdf", title: "Q3 report" },
    });

    const meta = JSON.parse(await readFile(join(artifactDir, "report.pdf.meta.json"), "utf8"));
    expect(meta).toMatchObject({
      sandbox_path: "/sandbox/artifacts/report.pdf",
      host_path: join(artifactDir, "report.pdf"),
      size_bytes: 1,
      title: "Q3 report",
    });
    expect(Date.parse(meta.exported_at)).not.toBeNaN();
  });

  it("falls back to the basename when no title is given", async () => {
    await setScript([{ match: "^cp", code: 0, writeArg: 2, writeContent: "x" }]);
    const res = await client.callTool({
      name: "sandbox_export_artifact",
      arguments: { sandbox_path: "/sandbox/artifacts/out.csv" },
    });

    expect(payload(res).title).toBe("out.csv");
  });

  it("errors when the file isn't in the container", async () => {
    await setScript([{ match: "^cp", code: 1, stderr: "No such container:path" }]);
    const res = await client.callTool({
      name: "sandbox_export_artifact",
      arguments: { sandbox_path: "/sandbox/missing.txt" },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/export \/sandbox\/missing.txt failed/);
  });
});

/* ─────────── protocol-level behaviour ─────────── */

describe("dispatch", () => {
  it("reports an unknown tool without crashing the server", async () => {
    const res = await client.callTool({ name: "sandbox_rm_rf", arguments: {} });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("unknown tool: sandbox_rm_rf");

    // The session survives, so one bad call doesn't end the run.
    const ok = await client.callTool({ name: "sandbox_exec", arguments: { cmd: "true" } });
    expect(ok.isError).toBeFalsy();
  });

  it("refuses to start unbound to a sandbox", async () => {
    // Without both env vars the server has no container to talk to;
    // exiting loudly beats serving tools that would target nothing.
    const { spawn } = await import("node:child_process");
    const env = { ...process.env };
    delete env.BEEVIBE_SANDBOX_ID;
    delete env.BEEVIBE_SANDBOX_ARTIFACTS;

    const proc = spawn("npx", ["--no-install", "tsx", SERVER], { env, stdio: "pipe" });
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    const code = await new Promise<number | null>((r) => proc.on("close", r));

    expect(code).toBe(2);
    expect(stderr).toContain("missing BEEVIBE_SANDBOX_ID or BEEVIBE_SANDBOX_ARTIFACTS");
  });

  it("stays usable across a sequence of calls", async () => {
    await setScript([
      { match: "ls -1", code: 0, stdout: "one\n" },
      { match: ".*", code: 0, stdout: "" },
    ]);
    await client.callTool({ name: "sandbox_exec", arguments: { cmd: "true" } });
    const listed = await client.callTool({ name: "sandbox_list", arguments: { path: "/sandbox" } });
    await client.callTool({ name: "sandbox_exec", arguments: { cmd: "true" } });

    expect(payload(listed)).toEqual({ entries: ["one"] });
    expect(await dockerCalls()).toHaveLength(3);
  });
});
