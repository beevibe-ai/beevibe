"use client";

import { setupCommandContext } from "@/lib/api/config";
import { type SegmentedTabOption } from "@/components/segmented-tabs";
import { SetupChannels, type SetupBundle } from "@/components/setup-channels";

export type CliChannel = "claude" | "codex" | "opencode" | "manual";

const CHANNEL_OPTIONS: readonly SegmentedTabOption<CliChannel>[] = [
  { id: "claude", label: "Claude Code", hint: "claude mcp add" },
  { id: "codex", label: "Codex", hint: "config.toml" },
  { id: "opencode", label: "opencode", hint: "opencode.json" },
  { id: "manual", label: "Manual", hint: "raw URL + token" },
];

const MCP_SERVER_NAME = "beevibe";

function buildBundle(channel: CliChannel, mcpUrl: string, token: string): SetupBundle {
  switch (channel) {
    case "claude":
      return {
        prelude: (
          <p className="text-xs text-muted-foreground leading-relaxed">
            One-shot — Claude Code persists the entry in <span className="font-mono">~/.claude.json</span>.
          </p>
        ),
        steps: [
          {
            label: `Register the ${MCP_SERVER_NAME} MCP server`,
            command:
              `claude mcp add --transport http ${MCP_SERVER_NAME} ${mcpUrl} \\\n` +
              `  --header "Authorization: Bearer ${token}"`,
          },
        ],
        epilogue: (
          <p className="text-[11px] text-muted-foreground/80 leading-snug pt-1">
            Then start <span className="font-mono">claude</span> in any directory and ask your
            team agent something (e.g. <span className="font-mono">/mcp</span> to verify the
            connection, then &ldquo;what tasks do I have open?&rdquo;).
          </p>
        ),
      };
    case "codex":
      return {
        prelude: (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Append to <span className="font-mono">~/.codex/config.toml</span>:
          </p>
        ),
        steps: [
          {
            label: "Add the MCP server block",
            command:
              `[mcp_servers.${MCP_SERVER_NAME}]\n` +
              `url = "${mcpUrl}"\n\n` +
              `[mcp_servers.${MCP_SERVER_NAME}.headers]\n` +
              `Authorization = "Bearer ${token}"`,
          },
        ],
        epilogue: (
          <p className="text-[11px] text-muted-foreground/80 leading-snug pt-1">
            Requires a Codex build with HTTP MCP transport support. Restart{" "}
            <span className="font-mono">codex</span> after editing the file.
          </p>
        ),
      };
    case "opencode":
      return {
        prelude: (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Add a <span className="font-mono">mcp.{MCP_SERVER_NAME}</span> entry to{" "}
            <span className="font-mono">~/.config/opencode/opencode.json</span>{" "}
            (or your project&apos;s <span className="font-mono">opencode.json</span>):
          </p>
        ),
        steps: [
          {
            label: "Register the remote MCP server",
            command: JSON.stringify(
              {
                mcp: {
                  [MCP_SERVER_NAME]: {
                    type: "remote",
                    url: mcpUrl,
                    headers: { Authorization: `Bearer ${token}` },
                    enabled: true,
                  },
                },
              },
              null,
              2,
            ),
          },
        ],
        epilogue: (
          <p className="text-[11px] text-muted-foreground/80 leading-snug pt-1">
            Restart <span className="font-mono">opencode</span> to pick up the new server.
          </p>
        ),
      };
    case "manual":
      return {
        prelude: (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Wire any MCP-capable client to these. Transport is HTTP
            (<span className="font-mono">StreamableHTTPServerTransport</span>); auth is a bearer header.
          </p>
        ),
        steps: [
          { label: "Server URL", command: mcpUrl },
          { label: "Auth header", command: `Authorization: Bearer ${token}` },
        ],
      };
  }
}

export function CliMcpInstructions({ className }: { className?: string }) {
  const { baseUrl, token } = setupCommandContext();
  return (
    <SetupChannels
      options={CHANNEL_OPTIONS}
      initial="claude"
      buildBundle={(channel) => buildBundle(channel, `${baseUrl}/mcp`, token)}
      // Every channel but "manual" is a single command; numbering it "1."
      // implies a step 2 that isn't coming.
      numbering="multi-step"
      className={className}
    />
  );
}
