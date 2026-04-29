/**
 * Dev convenience: boot @beevibe/api locally and expose it via Cloudflare
 * Tunnel (no signup, no token). Prints a ready-to-paste mcp-config.json
 * snippet so a remote Claude CLI can connect with `bv_u_` auth.
 *
 * Lifted from intentcore's `scripts/start-agent-mcp.ts` and adapted for the
 * new auth model (no OAuth — users paste their bv_u_ token directly into
 * their local mcp-config).
 *
 * Usage:
 *   pnpm tsx scripts/api-share.ts                  # tunnel mode (default)
 *   BEEVIBE_API_NO_TUNNEL=1 pnpm tsx scripts/api-share.ts   # local-only
 *
 * Requires `cloudflared` on PATH for tunnel mode (`brew install cloudflared`
 * on macOS). Fails over gracefully to local-only with install instructions.
 */

import { config as loadEnv } from "dotenv";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env") });

import { bootstrap } from "../packages/api/src/bootstrap.js";

const PORT = process.env.BEEVIBE_API_PORT ? Number(process.env.BEEVIBE_API_PORT) : 3000;
const NO_TUNNEL = process.env.BEEVIBE_API_NO_TUNNEL === "1";

const REQUIRED_ENV = ["DATABASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

async function main(): Promise<void> {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log(`[api-share] booting @beevibe/api on port ${PORT}`);
  const { server, shutdown } = await bootstrap({
    databaseUrl: process.env.DATABASE_URL!,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    port: PORT,
  });
  await server.start();
  console.log(`[api-share] api ready on http://localhost:${PORT}`);

  let tunnel: ChildProcess | null = null;
  if (NO_TUNNEL) {
    printLocalConfig(PORT);
  } else {
    tunnel = await startTunnel(PORT);
  }

  const stop = async (signal: string): Promise<void> => {
    console.log(`\n[api-share] ${signal} received, shutting down`);
    if (tunnel) {
      tunnel.kill("SIGTERM");
    }
    try {
      await shutdown();
    } catch (err) {
      console.error("[api-share] shutdown error:", err);
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
 * Spawn cloudflared, capture the printed `https://*.trycloudflare.com` URL
 * from stderr, and print a copy-pasteable mcp-config.json. Falls back to
 * local-only on any of: cloudflared missing, 15-second URL timeout.
 */
function startTunnel(port: number): Promise<ChildProcess> {
  return new Promise((resolveProc) => {
    let settled = false;

    const proc = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://localhost:${port}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    proc.on("error", () => {
      if (settled) return;
      settled = true;
      console.warn(
        "\n[api-share] cloudflared not found. Install with:\n" +
          "  brew install cloudflared (macOS) or see https://github.com/cloudflare/cloudflared",
      );
      printLocalConfig(port);
      resolveProc(proc);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      const match = text.match(/(https:\/\/[^\s]+\.trycloudflare\.com)/);
      if (match && !settled) {
        settled = true;
        printTunnelConfig(match[1]!);
        resolveProc(proc);
      }
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn("\n[api-share] cloudflared didn't print a URL in 15s. Falling back.");
      printLocalConfig(port);
      resolveProc(proc);
    }, 15_000);
  });
}

function printTunnelConfig(publicUrl: string): void {
  console.log(`
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Public: ${publicUrl}/mcp

  Add this to ~/.config/claude/mcp.json (or your local mcp-config.json):

  {
    "mcpServers": {
      "beevibe": {
        "type": "http",
        "url": "${publicUrl}/mcp",
        "headers": { "Authorization": "Bearer <YOUR_BV_U_TOKEN>" }
      }
    }
  }

  Replace <YOUR_BV_U_TOKEN> with your bv_u_ key. Provision one via the
  CLI: \`pnpm beevibe-cli provision-user --email you@example.com\`.

  Press Ctrl-C to stop the api + tunnel.
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

function printLocalConfig(port: number): void {
  console.log(`
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Local: http://localhost:${port}/mcp  (this machine only)

  Add this to ~/.config/claude/mcp.json (or your local mcp-config.json):

  {
    "mcpServers": {
      "beevibe": {
        "type": "http",
        "url": "http://localhost:${port}/mcp",
        "headers": { "Authorization": "Bearer <YOUR_BV_U_TOKEN>" }
      }
    }
  }

  Replace <YOUR_BV_U_TOKEN> with your bv_u_ key.

  Press Ctrl-C to stop the api.
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

main().catch((err: unknown) => {
  console.error("[api-share] fatal:", err);
  process.exit(1);
});
