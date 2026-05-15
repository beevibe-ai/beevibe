"use client";

import { useState, type ReactNode } from "react";
import { apiBaseUrl, getUserKey } from "@/lib/api/config";
import { CommandBlock } from "@/components/command-block";
import { cn } from "@/lib/utils";

export type CliChannel = "claude" | "codex" | "opencode" | "manual";

interface ChannelOption {
  id: CliChannel;
  label: string;
  hint: string;
}

const CHANNEL_OPTIONS: readonly ChannelOption[] = [
  { id: "claude", label: "Claude Code", hint: "claude mcp add" },
  { id: "codex", label: "Codex", hint: "config.toml" },
  { id: "opencode", label: "opencode", hint: "opencode.json" },
  { id: "manual", label: "Manual", hint: "raw URL + token" },
];

const MCP_SERVER_NAME = "beevibe";

interface SetupStep {
  label: string;
  command: string;
}

interface SetupBundle {
  prelude?: ReactNode;
  steps: readonly SetupStep[];
  epilogue?: ReactNode;
}

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
  const userKey = typeof window !== "undefined" ? getUserKey() : null;
  const base = apiBaseUrl ?? "http://localhost:3000";
  const mcpUrl = `${base}/mcp`;
  const token = userKey ?? "<your-key>";

  const [channel, setChannel] = useState<CliChannel>("claude");
  const bundle = buildBundle(channel, mcpUrl, token);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex gap-1 rounded-lg border border-border bg-card p-1">
        {CHANNEL_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => setChannel(opt.id)}
            className={cn(
              "flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer",
              channel === opt.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <div>{opt.label}</div>
            <div className="text-[10px] font-normal opacity-80 mt-0.5">{opt.hint}</div>
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {bundle.prelude}
        {bundle.steps.map((step, i) => (
          <CommandBlock
            key={i}
            label={bundle.steps.length > 1 ? `${i + 1}. ${step.label}` : step.label}
            command={step.command}
          />
        ))}
        {bundle.epilogue}
      </div>
    </div>
  );
}
