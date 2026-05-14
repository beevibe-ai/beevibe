"use client";

import { useState, type ReactNode } from "react";
import { apiBaseUrl, getUserKey } from "@/lib/api/config";
import { CommandBlock } from "@/components/command-block";
import { cn } from "@/lib/utils";

export type InstallChannel = "brew" | "npx" | "direct";

interface InstallOption {
  id: InstallChannel;
  label: string;
  hint: string;
}

const INSTALL_OPTIONS: readonly InstallOption[] = [
  { id: "brew", label: "Homebrew", hint: "macOS" },
  { id: "npx", label: "npx", hint: "any platform with Node" },
  { id: "direct", label: "Direct download", hint: "advanced" },
];

const RELEASES_URL = "https://github.com/beevibe-ai/beevibe/releases/latest";
const NPX_BIN = "npx -y @beevibe/daemon@latest";
const LOCAL_BIN = "beevibe-daemon";

interface InstallStepSpec {
  label: string;
  command: string;
}

interface InstallBundle {
  prelude?: ReactNode;
  steps: readonly InstallStepSpec[];
}

function buildInstallBundle(channel: InstallChannel, setupArgs: string): InstallBundle {
  switch (channel) {
    case "brew":
      return {
        steps: [
          { label: "Install via Homebrew", command: "brew install beevibe-ai/tap/beevibe-daemon" },
          { label: "Register", command: `${LOCAL_BIN} ${setupArgs}` },
          { label: "Start (long-running)", command: `${LOCAL_BIN} start` },
        ],
      };
    case "npx":
      return {
        steps: [
          {
            label: "Register (downloads daemon on first run)",
            command: `${NPX_BIN} ${setupArgs}`,
          },
          { label: "Start (long-running)", command: `${NPX_BIN} start` },
        ],
      };
    case "direct":
      return {
        prelude: (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Pick the binary that matches your platform from{" "}
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="underline hover:text-foreground"
            >
              the latest GitHub release
            </a>
            {" "}— darwin-arm64, darwin-x64, linux-x64, or linux-arm64. Then:
          </p>
        ),
        steps: [
          {
            label: "Download (substitute your platform)",
            command:
              `curl -fsSL -o ~/.local/bin/${LOCAL_BIN} \\\n` +
              `  "${RELEASES_URL}/download/${LOCAL_BIN}-darwin-arm64" \\\n` +
              `  && chmod +x ~/.local/bin/${LOCAL_BIN}`,
          },
          { label: "Register", command: `${LOCAL_BIN} ${setupArgs}` },
          { label: "Start (long-running)", command: `${LOCAL_BIN} start` },
        ],
      };
  }
}

// Runs once on mount — userAgent doesn't change for the page lifetime.
function detectDefaultChannel(): InstallChannel {
  if (typeof navigator === "undefined") return "npx";
  if (/Mac OS X|Macintosh/i.test(navigator.userAgent)) return "brew";
  return "npx";
}

export function DaemonInstallInstructions({ className }: { className?: string }) {
  const userKey = typeof window !== "undefined" ? getUserKey() : null;
  const apiUrl = apiBaseUrl ?? "http://localhost:3000";
  const keyOrPlaceholder = userKey ?? "<your-key>";
  const setupArgs = `setup --api ${apiUrl} --user-token ${keyOrPlaceholder}`;

  const [channel, setChannel] = useState<InstallChannel>(() => detectDefaultChannel());
  const bundle = buildInstallBundle(channel, setupArgs);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex gap-1 rounded-lg border border-border bg-card p-1">
        {INSTALL_OPTIONS.map((opt) => (
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
          <CommandBlock key={i} label={`${i + 1}. ${step.label}`} command={step.command} />
        ))}
      </div>
    </div>
  );
}
