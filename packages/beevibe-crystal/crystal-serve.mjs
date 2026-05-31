#!/usr/bin/env node
// crystal-serve — one command to try Crystal publicly.
//
// Brings up the local server + viewer behind a Cloudflare quick tunnel and
// prints a public https://*.trycloudflare.com URL you can share with anyone.
//
// Ephemeral by design: the URL lives only while this process runs, and rotates
// on the next start. Good for "quickly try and use"; for a stable URL you host
// the server somewhere durable and set CRYSTAL_VIEWER_URL yourself.
//
// Requires cloudflared (`brew install cloudflared`) and a configured key
// (`pnpm crystal:setup`).

import { spawn } from "node:child_process";

const VIEWER_PORT = Number(process.env.PORT_VIEWER || 5273);
const TUNNEL_TIMEOUT_MS = 30_000;
const children = [];

function shutdown(code = 0) {
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function startTunnel() {
  return new Promise((resolve, reject) => {
    const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${VIEWER_PORT}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const scan = (buf) => {
      const match = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !settled) {
        settled = true;
        resolve({ proc, url: match[0] });
      }
    };
    proc.stdout.on("data", scan);
    proc.stderr.on("data", scan);
    proc.on("error", (err) =>
      reject(new Error(`cloudflared failed to start: ${err.message}. Install it with 'brew install cloudflared'.`))
    );
    proc.on("exit", (code) => {
      if (!settled) reject(new Error(`cloudflared exited (code ${code}) before printing a tunnel URL.`));
    });
    setTimeout(() => {
      if (!settled) reject(new Error("Timed out waiting for the Cloudflare tunnel URL."));
    }, TUNNEL_TIMEOUT_MS);
  });
}

console.log("Starting Cloudflare quick tunnel…");
let tunnel;
try {
  tunnel = await startTunnel();
} catch (err) {
  console.error(err.message);
  shutdown(1);
}
children.push(tunnel.proc);
const publicUrl = tunnel.url;

// The server bakes CRYSTAL_VIEWER_URL into the share links it returns, so point
// it at the tunnel. The viewer proxies /api back to the local server.
const env = { ...process.env, CRYSTAL_VIEWER_URL: publicUrl };
children.push(spawn("node", ["server.mjs"], { stdio: "inherit", env }));
children.push(spawn("npx", ["vite"], { stdio: "inherit", env }));

console.log(`\n✦ Crystal is live (ephemeral): ${publicUrl}`);
console.log("   Run /crystal:publish in a Claude Code session — capsule links will use this URL.");
console.log("   Stop with Ctrl-C. The URL dies when this process exits.\n");
