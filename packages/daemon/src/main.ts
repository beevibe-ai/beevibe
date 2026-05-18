#!/usr/bin/env node
/**
 * `beevibe-daemon` CLI entry. Four subcommands:
 *   - setup --api <url> --user-token <bv_u_…> [--device-name <name>]
 *   - start
 *   - sync       Re-detect CLIs on PATH and register newly-installed ones.
 *   - update [--yes]
 *
 * The daemon owns its own config (~/.beevibe/config.json) and has no
 * legitimate reason to read a local .env. Compiled binaries are built
 * with `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`
 * (see packages/daemon/scripts/build-binaries.sh) so launching from
 * inside a beevibe checkout doesn't silently slurp the repo's .env.
 */

import { runSetup } from "./setup.js";
import { runStart } from "./start.js";
import { runSync } from "./sync.js";
import { runUpdate } from "./update.js";

interface Flags {
  api?: string;
  userToken?: string;
  deviceName?: string;
  externalId?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--api" || arg === "-a") && next) {
      flags.api = next;
      i += 1;
    } else if ((arg === "--user-token" || arg === "-t") && next) {
      flags.userToken = next;
      i += 1;
    } else if (arg === "--device-name" && next) {
      flags.deviceName = next;
      i += 1;
    } else if (arg === "--external-id" && next) {
      flags.externalId = next;
      i += 1;
    }
  }
  return flags;
}

function printHelp(): void {
  console.log(
    [
      "Usage: beevibe-daemon <command> [flags]",
      "",
      "Commands:",
      "  setup    Register this machine with a beevibe api server.",
      "  start    Run the daemon: claim pending sessions and spawn the CLI.",
      "  sync     Re-detect CLIs on PATH and register newly-installed ones.",
      "  update   Check for and install a newer daemon binary (brew/curl installs).",
      "",
      "setup flags:",
      "  --api, -a <url>            beevibe api base URL (e.g. http://localhost:3000)",
      "  --user-token, -t <bv_u_…>  human bv_u_ token (one-time, used to mint a bv_d_)",
      "  --device-name <name>       optional friendly name (defaults to user@hostname)",
      "  --external-id <id>         optional stable per-machine id (defaults to hostname)",
      "",
      "update flags:",
      "  --yes, -y                  skip the install-this-update prompt",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "setup") {
    const flags = parseFlags(rest);
    if (!flags.api || !flags.userToken) {
      console.error("setup requires --api and --user-token");
      printHelp();
      process.exit(2);
    }
    const cfg = await runSetup({
      apiUrl: flags.api,
      userToken: flags.userToken,
      deviceName: flags.deviceName,
      externalId: flags.externalId,
    });
    console.log(`Registered as ${cfg.daemon_id}`);
    console.log(`Runtimes: ${cfg.runtimes.map((r) => `${r.cli} (${r.id})`).join(", ")}`);
    console.log("Config saved to ~/.beevibe/config.json");
    return;
  }

  if (command === "start") {
    await runStart();
    return;
  }

  if (command === "sync") {
    const result = await runSync();
    if (result.added.length === 0) {
      console.log("No new CLIs detected.");
    } else {
      console.log(
        `Added ${result.added.length} runtime(s): ${result.added
          .map((r) => `${r.cli} (${r.id})`)
          .join(", ")}.`,
      );
      console.log("Restart the daemon to pick up the new runtime(s).");
    }
    return;
  }

  if (command === "update") {
    const skipPrompt = rest.includes("--yes") || rest.includes("-y");
    await runUpdate({ skipPrompt });
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
