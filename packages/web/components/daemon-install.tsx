"use client";

import { setupCommandContext } from "@/lib/api/config";
import { type SegmentedTabOption } from "@/components/segmented-tabs";
import { SetupChannels, type SetupBundle } from "@/components/setup-channels";

export type InstallChannel = "brew" | "npx" | "direct";

const INSTALL_OPTIONS: readonly SegmentedTabOption<InstallChannel>[] = [
  { id: "brew", label: "Homebrew", hint: "macOS" },
  { id: "npx", label: "npx", hint: "any platform with Node" },
  { id: "direct", label: "Direct download", hint: "advanced" },
];

const RELEASES_URL = "https://github.com/beevibe-ai/beevibe/releases/latest";
const NPX_BIN = "npx -y @beevibe/daemon@latest";
const LOCAL_BIN = "beevibe-daemon";

function buildInstallBundle(channel: InstallChannel, setupArgs: string): SetupBundle {
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
  const { baseUrl, token } = setupCommandContext();
  const setupArgs = `setup --api ${baseUrl} --user-token ${token}`;
  return (
    <SetupChannels
      options={INSTALL_OPTIONS}
      initial={detectDefaultChannel}
      buildBundle={(channel) => buildInstallBundle(channel, setupArgs)}
      className={className}
    />
  );
}
