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
import { SandboxError, type Sandbox } from "./docker.js";
import { makeTools } from "./tools.js";

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

main().catch((err) => {
  process.stderr.write(
    `[beevibe-sandbox-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
