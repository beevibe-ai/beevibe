/**
 * M6.0.1 probe — verifies that the Claude Code CLI auto-echoes the
 * server-assigned `Mcp-Session-Id` header per MCP Streamable HTTP spec
 * 2025-11-25 §Session Management.
 *
 * Path B (user-driven `bv_u_` flow) hinges on this header round-trip. If
 * the CLI is non-compliant, M6.1 needs a fallback (token + connection
 * fingerprint) before Path B is built.
 *
 * Usage:
 *   RUN_MCP_PROBE=1 pnpm tsx scripts/probe-mcp-session-id.ts
 *
 * Then, in another terminal:
 *
 *   mkdir -p /tmp/beevibe-probe && cat > /tmp/beevibe-probe/mcp-config.json <<'EOF'
 *   { "mcpServers": { "probe": { "type": "http", "url": "http://localhost:3099/mcp" } } }
 *   EOF
 *   cd /tmp/beevibe-probe && claude --mcp-config ./mcp-config.json --max-turns 3 \
 *     --dangerously-skip-permissions 'use the ping tool then exit'
 *
 * After the CLI runs, send SIGINT (Ctrl-C) to the probe to print the verdict.
 */

import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env") });

import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

async function main(): Promise<void> {
  if (process.env.RUN_MCP_PROBE !== "1") {
    console.log("Set RUN_MCP_PROBE=1 to run this probe.");
    process.exit(0);
  }

  const PORT = 3099;
  const observedSessionIds: string[] = [];
  const observedMethods: string[] = [];
  let assignedSessionId: string | undefined;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      const id = randomUUID();
      assignedSessionId = id;
      console.log(`[probe] assigned Mcp-Session-Id: ${id}`);
      return id;
    },
  });

  const server = new McpServer(
    { name: "beevibe-probe", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.tool(
    "ping",
    "Replies with 'pong'. Used to verify the MCP transport.",
    {},
    async () => ({
      content: [{ type: "text", text: "pong" }],
    }),
  );

  await server.connect(transport);

  const app = express();
  app.use(express.json());

  app.use("/mcp", (req, _res, next) => {
    const sid = req.headers["mcp-session-id"];
    const method = (req.body as { method?: string } | undefined)?.method ?? "(no method in body)";
    observedMethods.push(method);
    if (sid && typeof sid === "string") {
      observedSessionIds.push(sid);
      console.log(`[probe] inbound: method=${method} sid=${sid}`);
    } else {
      console.log(`[probe] inbound: method=${method} (no Mcp-Session-Id header)`);
    }
    next();
  });

  app.all("/mcp", (req, res) => {
    void transport.handleRequest(req, res, req.body);
  });

  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}/mcp`;
    console.log("");
    console.log("=".repeat(72));
    console.log(`[probe] listening on ${url}`);
    console.log("=".repeat(72));
    console.log("");
    console.log("Run a Claude CLI session pointed at this probe (in another terminal).");
    console.log("Copy-paste each block separately to avoid heredoc indentation issues.");
    console.log("");
    console.log("Block 1 — write the mcp-config:");
    console.log("");
    console.log(`mkdir -p /tmp/beevibe-probe`);
    console.log(`cat > /tmp/beevibe-probe/mcp-config.json <<'EOF'`);
    console.log(`{ "mcpServers": { "probe": { "type": "http", "url": "${url}" } } }`);
    console.log(`EOF`);
    console.log("");
    console.log("Block 2 — run the Claude CLI in print mode (matches M5's headless invocation):");
    console.log("");
    console.log(`cd /tmp/beevibe-probe && claude --print --strict-mcp-config --mcp-config ./mcp-config.json --max-turns 3 --dangerously-skip-permissions 'Call the mcp__probe__ping tool then say done.'`);
    console.log("");
    console.log("After the CLI runs, press Ctrl-C here to see the PASS/FAIL verdict.");
    console.log("=".repeat(72));
    console.log("");
  });

  process.on("SIGINT", () => {
    console.log("");
    console.log("=".repeat(72));
    console.log("[probe] verdict");
    console.log("=".repeat(72));

    if (!assignedSessionId) {
      console.log("");
      console.log("✗ FAIL: probe never assigned a Mcp-Session-Id.");
      console.log("  No initialize request reached the server. Check that the CLI");
      console.log("  is pointing at the right URL and that no firewall is blocking.");
      process.exit(2);
    }

    console.log("");
    console.log(`assigned Mcp-Session-Id: ${assignedSessionId}`);
    console.log(`total inbound requests:  ${observedMethods.length}`);
    console.log(`requests carrying sid:   ${observedSessionIds.length}`);
    console.log(`methods seen:            ${observedMethods.join(", ")}`);

    const echoesMatchingAssigned = observedSessionIds.filter((s) => s === assignedSessionId).length;

    if (echoesMatchingAssigned >= 1) {
      console.log("");
      console.log(`✓ PASS: CLI auto-echoed Mcp-Session-Id on ${echoesMatchingAssigned} subsequent request(s).`);
      console.log("  Path B (bv_u_ flow via header round-trip) is viable.");
      process.exit(0);
    }

    console.log("");
    console.log("✗ FAIL: CLI did NOT echo Mcp-Session-Id on subsequent requests.");
    console.log("  Need a fallback for Path B (token + connection fingerprint).");
    console.log("  Flag this in M6.1 design before building user-driven sessions.");
    process.exit(2);
  });
}

main().catch((err: unknown) => {
  console.error("[probe] fatal:", err);
  process.exit(1);
});
