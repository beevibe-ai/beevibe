#!/usr/bin/env node
/**
 * Beevibe sandbox MCP server.
 *
 * Spawned by the orchestrator per-run via stdio. Exposes five tools
 * (`sandbox_exec`, `sandbox_read_file`, `sandbox_write_file`,
 * `sandbox_list`, `sandbox_export_artifact`) that wrap the primitives
 * in `./docker.ts`. The child claude session connects to this MCP
 * server via stdio and is restricted via `--allowedTools` to only
 * these calls — its host `Bash` tool is disabled.
 *
 * The server is bound to a single sandbox at startup via two env vars:
 *   BEEVIBE_SANDBOX_ID         — container id (also docker name)
 *   BEEVIBE_SANDBOX_ARTIFACTS  — host path of the sandbox's artifact dir
 *
 * Both are produced by `createSandbox()` and passed through the
 * MCP config file the orchestrator writes for the claude CLI.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  exec,
  exportArtifact,
  listDir,
  readFileIn,
  SandboxError,
  writeFileIn,
  type Sandbox,
} from "./docker.js";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
  };
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

function makeTools(sandbox: Sandbox): ToolDef[] {
  return [
    {
      name: "sandbox_exec",
      description:
        "Run a shell command inside the sandbox container. Returns stdout, " +
        "stderr, exit code, and elapsed seconds. Use this for git clone, " +
        "package installs, running scripts, listing files, etc. The command " +
        "runs in /sandbox by default. There is no host shell — every shell " +
        "operation MUST go through this tool.",
      inputSchema: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "Shell command to run." },
          cwd: {
            type: "string",
            description: "Working directory inside the sandbox. Defaults to /sandbox.",
          },
          timeout_seconds: {
            type: "number",
            description: "Per-command timeout (default 300, hard cap).",
          },
        },
        required: ["cmd"],
      },
      handler: async (input) => {
        const cmd = requireString(input, "cmd");
        const cwd = optionalString(input, "cwd");
        const timeout = optionalNumber(input, "timeout_seconds");
        const r = await exec(sandbox, cmd, {
          cwd,
          timeout_seconds: timeout,
        });
        return {
          stdout: capBytes(r.stdout, 64_000),
          stderr: capBytes(r.stderr, 16_000),
          exit_code: r.exit_code,
          timed_out: r.timed_out,
          duration_seconds: r.duration_seconds,
        };
      },
    },
    {
      name: "sandbox_read_file",
      description:
        "Read a UTF-8 text file from inside the sandbox. Returns the file " +
        "contents as a string. Capped at 1MB; use sandbox_exec with grep / " +
        "head / tail for larger files.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path inside the sandbox, e.g. /sandbox/repo/README.md.",
          },
          max_bytes: {
            type: "number",
            description: "Hard cap on bytes returned (default 1,000,000).",
          },
        },
        required: ["path"],
      },
      handler: async (input) => {
        const path = requireString(input, "path");
        const max_bytes = optionalNumber(input, "max_bytes");
        const content = await readFileIn(sandbox, path, { max_bytes });
        return { content };
      },
    },
    {
      name: "sandbox_write_file",
      description:
        "Write a UTF-8 text file inside the sandbox. Creates the parent " +
        "directory if needed. Use this to write glue scripts, adapter code, " +
        "config files. There is no host filesystem access — every file the " +
        "agent creates must go through this tool.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path inside the sandbox.",
          },
          content: {
            type: "string",
            description: "File contents (UTF-8).",
          },
        },
        required: ["path", "content"],
      },
      handler: async (input) => {
        const path = requireString(input, "path");
        const content = requireString(input, "content");
        await writeFileIn(sandbox, path, content);
        return { ok: true };
      },
    },
    {
      name: "sandbox_list",
      description:
        "List the entries of a directory inside the sandbox. Returns an " +
        "array of filenames (basenames, not full paths). Use sandbox_exec " +
        "with `ls -la` if you need details.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute directory path inside the sandbox.",
          },
        },
        required: ["path"],
      },
      handler: async (input) => {
        const path = requireString(input, "path");
        const entries = await listDir(sandbox, path);
        return { entries };
      },
    },
    {
      name: "sandbox_export_artifact",
      description:
        "Publish a file from inside the sandbox as an artifact for the " +
        "parent run. Returns a host-side artifact descriptor (path + size). " +
        "Call this on every file you want the parent agent / user to see. " +
        "Files that aren't exported are lost when the sandbox tears down.",
      inputSchema: {
        type: "object",
        properties: {
          sandbox_path: {
            type: "string",
            description: "Absolute path inside the sandbox of the file to export.",
          },
          title: {
            type: "string",
            description:
              "Optional human-readable title. The orchestrator uses this for the artifact's display name.",
          },
        },
        required: ["sandbox_path"],
      },
      handler: async (input) => {
        const sandbox_path = requireString(input, "sandbox_path");
        const title = optionalString(input, "title");
        const r = await exportArtifact(sandbox, sandbox_path);
        // Write an artifact-metadata sidecar so the orchestrator can
        // pick titles back up after the run finishes.
        try {
          const meta = {
            sandbox_path,
            host_path: r.host_path,
            size_bytes: r.size_bytes,
            title: title ?? sandbox_path.split("/").pop() ?? "artifact",
            exported_at: new Date().toISOString(),
          };
          // Sidecar in the artifact dir, kept tiny and parsed by the
          // orchestrator after the agent exits.
          const sidecarPath = `${r.host_path}.meta.json`;
          await (await import("node:fs/promises")).writeFile(
            sidecarPath,
            JSON.stringify(meta, null, 2),
            "utf8",
          );
        } catch {
          // Sidecar is a nice-to-have; the orchestrator can fall back
          // to filename-only display if it isn't there.
        }
        return {
          host_path: r.host_path,
          size_bytes: r.size_bytes,
          title: title ?? sandbox_path.split("/").pop() ?? "artifact",
        };
      },
    },
  ];
}

async function main(): Promise<void> {
  const id = process.env.BEEVIBE_SANDBOX_ID;
  const artifacts = process.env.BEEVIBE_SANDBOX_ARTIFACTS;
  if (!id || !artifacts) {
    process.stderr.write(
      "[beevibe-sandbox-mcp] missing BEEVIBE_SANDBOX_ID or BEEVIBE_SANDBOX_ARTIFACTS env\n",
    );
    process.exit(2);
  }
  const sandbox: Sandbox = {
    id,
    artifact_dir: artifacts,
    image: "(bound)",
    created_at: new Date(),
  };
  const tools = makeTools(sandbox);
  const byName = new Map(tools.map((t) => [t.name, t] as const));

  const server = new Server(
    { name: "beevibe-sandbox", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler(req.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (err) {
      const msg = err instanceof SandboxError ? err.message : String(err);
      return {
        content: [{ type: "text", text: `error: ${msg}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") {
    throw new SandboxError(`missing or invalid "${key}" (string required)`);
  }
  return v;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new SandboxError(`invalid "${key}" (string expected)`);
  }
  return v;
}

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number") {
    throw new SandboxError(`invalid "${key}" (number expected)`);
  }
  return v;
}

function capBytes(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} bytes]…\n`;
}

main().catch((err) => {
  process.stderr.write(
    `[beevibe-sandbox-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
