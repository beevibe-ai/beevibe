import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs/promises";
import path from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));
const viewerPort = Number(process.env.CRYSTAL_VIEWER_PORT || 5273);
const apiTarget = (process.env.CRYSTAL_BALL_SERVER_URL || "http://127.0.0.1:5274").replace(/\/$/, "");

// SPA crawlers (Twitter, Slack, Discord, etc.) don't run JS — they read the
// raw HTML for og:* meta tags. Intercept /c/:id for known bot UAs and serve
// HTML with per-capsule title/description so embeds show the real gist.
const BOT_RE = /bot|crawler|spider|crawling|slack|discord|twitterbot|facebookexternalhit|linkedinbot|whatsapp|telegrambot|preview|skype|embedly/i;
function ogPlugin(rootDir) {
  return {
    name: "crystal-og",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const ua = String(req.headers["user-agent"] || "");
        const match = req.url?.match(/^\/c\/([a-z0-9]{4,32})(?:\?.*)?$/i);
        if (!match || !BOT_RE.test(ua)) return next();
        try {
          const capsuleId = match[1];
          const file = path.join(rootDir, ".capsules", `${capsuleId}.json`);
          const capsule = JSON.parse(await fs.readFile(file, "utf8"));
          const proto = req.headers["x-forwarded-proto"] || "http";
          const host = req.headers["x-forwarded-host"] || req.headers.host;
          const origin = `${proto}://${host}`;
          const fullUrl = `${origin}${req.url}`;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(renderOg({ capsule, url: fullUrl, origin }));
        } catch {
          next();
        }
      });
    },
  };
}

function htmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderOg({ capsule, url, origin }) {
  const title = capsule.title || "Beevibe Crystal capsule";
  const description = (capsule.gist || capsule.summary || "Ask the crystal anything - it answers in the publisher's voice.").slice(0, 300);
  const image = `${origin}/og.svg`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${htmlEscape(title)} · Beevibe Crystal</title>
    <meta name="description" content="${htmlEscape(description)}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Beevibe" />
    <meta property="og:title" content="${htmlEscape(title)}" />
    <meta property="og:description" content="${htmlEscape(description)}" />
    <meta property="og:url" content="${htmlEscape(url)}" />
    <meta property="og:image" content="${htmlEscape(image)}" />
    <meta property="og:image:type" content="image/svg+xml" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${htmlEscape(title)}" />
    <meta name="twitter:description" content="${htmlEscape(description)}" />
    <meta name="twitter:image" content="${htmlEscape(image)}" />
  </head>
  <body>
    <p>${htmlEscape(description)}</p>
    <p><a href="${htmlEscape(url)}">Open this capsule</a></p>
  </body>
</html>`;
}

export default defineConfig({
  root,
  base: "/",
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  plugins: [react(), ogPlugin(root)],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: viewerPort,
    // Vite 5+ rejects requests with Host headers it doesn't know. Cloudflare
    // Tunnel rotates trycloudflare.com subdomains every run, so allow all.
    allowedHosts: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        // SSE: don't buffer; pass chunks straight through
        ws: false,
      },
    },
  },
});
