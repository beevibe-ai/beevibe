// @beevibe/core — shared library.
// Binaries (mcp-server, executor, web) import domain types + port interfaces from here.
// Adapters are composed by binaries directly; not re-exported via the barrel.
export * from "./domain/index.js";
export * from "./ports/index.js";
export * from "./auth/index.js";
