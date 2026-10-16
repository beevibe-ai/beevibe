import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryStack,
  createWorkspaceStack,
  resolveSkillsSourceDir,
} from "./composition.js";
import type { CoreMemoryBlockRepository } from "./ports/core-memory-repo.js";
import type { MemoryFactRepository } from "./ports/memory-fact-repo.js";

// The stacks construct real adapters, and the two provider SDKs read their
// key from the environment when the config omits one. Supplying keys keeps
// these tests independent of whether the sandbox has any.
const KEYS = { openaiApiKey: "sk-openai-test", anthropicApiKey: "sk-anthropic-test" };

const repos = {
  coreMemoryRepo: {} as CoreMemoryBlockRepository,
  memoryFactRepo: {} as MemoryFactRepository,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSkillsSourceDir", () => {
  it("prefers an explicit directory", () => {
    expect(resolveSkillsSourceDir("/srv/skills")).toBe("/srv/skills");
  });

  it("falls back to <cwd>/skills", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/srv/app");
    expect(resolveSkillsSourceDir()).toBe(path.resolve("/srv/app", "skills"));
  });

  // An empty string is a real failure mode here — a stray `BEEVIBE_SKILLS_DIR=`
  // line in .env reaches this as "". `??` accepts it, which is the existing
  // behavior both bootstraps had; pinning it means a change to `||` is a
  // deliberate edit rather than a silent one.
  it("treats an empty string as configured, matching the previous inline default", () => {
    expect(resolveSkillsSourceDir("")).toBe("");
  });
});

describe("createMemoryStack", () => {
  // The factory has to close over the stack's own services rather than
  // rebuild them per agent: SessionCache calls it once per evicted session.
  it("builds a distinct MemoryAgent per id from one shared stack", () => {
    const stack = createMemoryStack({ ...repos, ...KEYS });
    const a = stack.makeMemoryAgent("agent_1");
    const b = stack.makeMemoryAgent("agent_2");
    expect(a).not.toBe(b);
  });
});

describe("createWorkspaceStack", () => {
  const cfg = { mcpServerUrl: "https://api.example.com/mcp", workspaceRoot: "/srv/workspaces" };

  it("registers the three CLI runtimes", () => {
    const { runtimeRegistry } = createWorkspaceStack(cfg);
    expect(Object.keys(runtimeRegistry).sort()).toEqual(["claude", "codex", "opencode"]);
  });

  // The two facts the call sites can no longer get wrong, asserted from the
  // manager's own config: it holds the very registry that was returned
  // alongside it (it can't be built before one exists — it looks up each
  // agent's runtime per call), and its skills dir went through the shared
  // default rather than being left undefined.
  it("wires the returned registry and a defaulted skills dir into the manager", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/srv/app");
    const { runtimeRegistry, workspaceManager } = createWorkspaceStack(cfg);
    const { config } = workspaceManager as unknown as {
      config: { runtimeRegistry: unknown; skillsSourceDir: string };
    };
    expect(config.runtimeRegistry).toBe(runtimeRegistry);
    expect(config.skillsSourceDir).toBe(path.resolve("/srv/app", "skills"));
  });

  it("rejects a relative workspace root at construction time", () => {
    expect(() => createWorkspaceStack({ ...cfg, workspaceRoot: "relative/path" })).toThrow(
      /must be absolute/,
    );
  });
});
