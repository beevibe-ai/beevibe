#!/usr/bin/env node
// crystal-doctor — paste your Anthropic API key once; the Crystal server reads it.
//
// Two modes:
//   crystal-doctor          audit-only: reports whether a key is configured.
//                           Exit 0 if ready, 1 if not. Non-interactive.
//   crystal-doctor setup    interactive: prompts you to paste your key and
//                           writes it to ~/.beevibe/crystal/config.json (0600).
//
// The key is pasted HERE, in your terminal — never into a Claude Code chat.
// That matters: Crystal publishes your session, so a key typed into the chat
// would end up inside the capsule you share. This keeps it out of band.
//
// The server reads ~/.beevibe/crystal/config.json on startup and falls back to
// env vars, so once you run setup you never have to export anything.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const CONFIG_DIR = path.join(os.homedir(), ".beevibe", "crystal");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const KEY = "ANTHROPIC_API_KEY";
const KEY_URL = "https://console.anthropic.com/settings/keys";

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function mask(value) {
  if (!value) return null;
  return value.length <= 8 ? "*".repeat(value.length) : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

async function setup() {
  const config = await loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("Beevibe Crystal — API key setup");
  console.log(`Writing to: ${CONFIG_PATH}\n`);

  const envKey = process.env[KEY]?.trim();
  if (envKey) {
    console.log(`Note: ${KEY} is set in your environment (${mask(envKey)}); it overrides this file.\n`);
  }

  const existing = (config[KEY] || "").trim();
  if (existing) {
    const keep = (await rl.question(`${KEY} already saved (${mask(existing)}). Keep it? [Y/n]: `)).trim().toLowerCase();
    if (keep !== "n" && keep !== "no") {
      rl.close();
      console.log("Kept the existing key. Nothing changed.");
      return;
    }
  }

  console.log(`Get a key at ${KEY_URL}`);
  const value = (await rl.question("Paste your Anthropic API key (leave blank to skip): ")).trim();
  rl.close();

  if (!value) {
    console.log("No key entered — nothing saved.");
    return;
  }

  config[KEY] = value;
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`\n✓ Saved to ${CONFIG_PATH} (read/write for you only).`);
  console.log("Restart the Crystal server if it's already running so it picks up the key.");
}

async function audit() {
  const config = await loadConfig();
  const envKey = process.env[KEY]?.trim();
  const configKey = (config[KEY] || "").trim();
  const value = envKey || configKey;
  const source = envKey ? "env" : configKey ? "config" : null;

  console.log(`Config file: ${CONFIG_PATH}`);
  if (value) {
    console.log(`${KEY}: set (${mask(value)}, from ${source})`);
    console.log("Crystal is ready to answer visitor questions.");
    process.exit(0);
  }
  console.log(`${KEY}: NOT set`);
  console.log("Run `pnpm crystal:setup` (or `node crystal-doctor.mjs setup`) to paste your key.");
  process.exit(1);
}

const mode = process.argv[2];
if (mode === "setup") {
  await setup();
} else {
  await audit();
}
