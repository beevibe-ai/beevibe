// @beevibe/core — shared library
// Folder layout (to be populated M1+):
//   domain/    pure types, zero deps
//   ports/     interfaces core needs
//   services/  use cases (no I/O)
//   adapters/  concrete infrastructure (postgres, pgvector, openai, anthropic, claude-code, git)
//   auth/      API key validation, caller resolution
export {};
