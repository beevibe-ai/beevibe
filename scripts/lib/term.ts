/**
 * ANSI colors and the console helpers the dev/ops scripts print with.
 *
 * `init.ts` and `provision-user.ts` each carried the same five color
 * one-liners; `test-session-search.ts` and `seed-session-search-demo.ts`
 * wrote the escapes inline, which is why the same "bold cyan heading"
 * appears three times in three spellings. Nothing here is clever — the
 * point is that a script shouldn't have to re-derive `\x1b[36m` to print
 * a line, and the shared vocabulary keeps the output of a `pnpm`-run
 * script recognizable across scripts.
 */

const wrap = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");

/** `✓ msg`, indented — a step that succeeded. */
export const ok = (msg: string): void => console.log(`  ${green("✓")} ${msg}`);

/** `→ msg`, indented — what the script is about to do. */
export const info = (msg: string): void => console.log(`  ${cyan("→")} ${msg}`);

/** `! msg`, indented — a skipped or degraded step, not a failure. */
export const warn = (msg: string): void => console.log(`  ${yellow("!")} ${msg}`);

/** `✗ msg` on stderr, indented — a step that failed. */
export const fail = (msg: string): void => console.error(`  ${red("✗")} ${msg}`);

/** A blank line then a bold cyan heading, to open a section. */
export const header = (msg: string): void => console.log(`\n${bold(cyan(msg))}`);

/** A numbered heading, for scripts that walk the user through ordered steps. */
export const step = (n: number, msg: string): void =>
  console.log(`\n${bold(`Step ${n}.`)} ${msg}`);
