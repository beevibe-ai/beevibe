/**
 * Verify: does codex actually treat `[profiles.<name>] instructions = "..."`
 * as a developer/system message (separate from user input) when set via
 * `-c profiles.<name>.instructions=...` + `--profile <name>`?
 *
 * The pirate test:
 *   - profile.instructions tells codex to speak like a pirate
 *   - user prompt is a neutral "say hello"
 *   - if instructions ARE applied: response is pirate-speak ("ahoy", "ye", etc.)
 *   - if instructions are IGNORED: plain "hello"
 *
 * Also tests the stdin-pipe (paperclip-style) shape: prompt arg = `-`,
 * user intent piped to stdin.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliProcess } from "../packages/core/src/adapters/claude-code/spawn.js";
import { parseCodexEventLine, parseCodexEvents } from "../packages/core/src/adapters/codex/stream-json.js";
import type { CodexEvent } from "../packages/core/src/adapters/codex/stream-json.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const PIRATE = "You are a pirate from the 1700s. You MUST speak in pirate dialect for every word. Use 'ahoy', 'ye', 'matey', 'arrr' liberally. No standard English.";

async function runOnce(label: string, args: string[], stdin?: string): Promise<string> {
  const ws = mkdtempSync(join(tmpdir(), "beevibe-pirate-"));
  try {
    const lastMsgPath = join(ws, ".last.txt");
    const fullArgs = [
      ...args,
      "--sandbox", "workspace-write",
      "--ask-for-approval", "never",
      "--cd", ws,
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--output-last-message", lastMsgPath,
      ...(stdin ? ["-"] : []),
    ];
    if (!stdin) fullArgs.push("Say hello to me in one short sentence.");

    console.log(`${BOLD}━━ ${label} ━━${RESET}`);
    console.log(`${DIM}argv: ${["codex", ...fullArgs.map((a) => a.includes(" ") ? `"${a.slice(0, 80)}${a.length > 80 ? "…" : ""}"` : a)].join(" ")}${RESET}`);

    const events: CodexEvent[] = [];
    let pending = "";
    const result = await runCliProcess({
      command: "codex",
      args: fullArgs,
      cwd: ws,
      env: process.env,
      stdin,
      onLog: (stream, chunk) => {
        if (stream !== "stdout") return;
        pending += chunk;
        let nl: number;
        while ((nl = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          const evt = parseCodexEventLine(line);
          if (evt) events.push(evt);
        }
      },
    });
    if (pending) {
      const evt = parseCodexEventLine(pending);
      if (evt) events.push(evt);
    }

    if (result.exitCode !== 0) {
      console.log(`${RED}exit ${result.exitCode}${RESET}`);
      console.log(`${DIM}stderr: ${result.stderr.slice(-500)}${RESET}`);
      return "";
    }
    const parsed = parseCodexEvents(events, result.exitCode, "");
    console.log(`${DIM}output: ${JSON.stringify(parsed.output)}${RESET}\n`);
    return parsed.output ?? "";
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

function isPirate(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("ahoy") ||
    lower.includes("matey") ||
    lower.includes("arrr") ||
    lower.includes("aye") ||
    /\bye\b/.test(lower) ||
    /\bbe\b.*(?:lookin|sailin|talkin)/.test(lower)
  );
}

async function main(): Promise<void> {
  console.log(`${BOLD}Codex system-prompt injection — does it actually separate identity from intent?${RESET}\n`);

  // Baseline: no instructions, just "say hello" → expect plain English.
  const baseline = await runOnce("Baseline (no instructions)", []);

  // Test A: profile.instructions via -c override + --profile
  const profileResp = await runOnce(
    "A: -c profiles.beevibe.instructions=… + --profile beevibe (the candidate)",
    [
      "-c", `profiles.beevibe.instructions=${JSON.stringify(PIRATE)}`,
      "--profile", "beevibe",
    ],
  );

  // Test B: paperclip-style — prepend instructions to stdin, no profile.
  const stdinResp = await runOnce(
    "B: paperclip-style — instructions prepended to stdin, no profile",
    [],
    `${PIRATE}\n\nSay hello to me in one short sentence.`,
  );

  // Test C: our current shape — instructions inside <beevibe_system_context> on positional arg
  const currentResp = await runOnce(
    "C: current beevibe shape — <beevibe_system_context> wrap on positional arg",
    [],
  ).then(() =>
    runOnce(
      "C: current beevibe shape (continued)",
      [],
      undefined,
    ),
  );
  // Need to actually run C with our wrap. Let me redo it:
  const _ = currentResp;
  const wrappedArg = `<beevibe_system_context>\n${PIRATE}\n</beevibe_system_context>\n\nSay hello to me in one short sentence.`;
  const currentRespReal = await (async () => {
    const ws = mkdtempSync(join(tmpdir(), "beevibe-pirate-"));
    try {
      const lastMsgPath = join(ws, ".last.txt");
      const args = [
        "--sandbox", "workspace-write",
        "--ask-for-approval", "never",
        "--cd", ws,
        "exec", "--json", "--skip-git-repo-check",
        "--output-last-message", lastMsgPath,
        wrappedArg,
      ];
      console.log(`${BOLD}━━ C: current shape (positional arg, XML wrap) ━━${RESET}`);
      const events: CodexEvent[] = [];
      let pending = "";
      const result = await runCliProcess({
        command: "codex",
        args,
        cwd: ws,
        env: process.env,
        onLog: (stream, chunk) => {
          if (stream !== "stdout") return;
          pending += chunk;
          let nl: number;
          while ((nl = pending.indexOf("\n")) !== -1) {
            const evt = parseCodexEventLine(pending.slice(0, nl));
            if (evt) events.push(evt);
            pending = pending.slice(nl + 1);
          }
        },
      });
      const parsed = parseCodexEvents(events, result.exitCode, "");
      console.log(`${DIM}output: ${JSON.stringify(parsed.output)}${RESET}\n`);
      return parsed.output ?? "";
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  })();

  console.log(`${BOLD}━━ Verdict ━━${RESET}`);
  const verdict = (label: string, resp: string, expectPirate: boolean): void => {
    const got = isPirate(resp);
    const correct = got === expectPirate;
    const tag = correct ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`${tag} ${label}: pirate=${got} (expected ${expectPirate})`);
  };
  verdict("Baseline (no instructions)", baseline, false);
  verdict("A: --profile + -c profiles.instructions", profileResp, true);
  verdict("B: paperclip stdin-prepend", stdinResp, true);
  verdict("C: positional <beevibe_system_context> wrap", currentRespReal, true);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
