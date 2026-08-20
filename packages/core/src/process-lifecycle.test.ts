import { describe, expect, it, vi, afterEach } from "vitest";
import { installShutdownHandlers, resolveRuntimeEnv, runEntrypoint } from "./process-lifecycle.js";

const FULL_ENV = {
  DATABASE_URL: "postgres://localhost/beevibe",
  OPENAI_API_KEY: "sk-openai",
  ANTHROPIC_API_KEY: "sk-anthropic",
  BEEVIBE_MCP_SERVER_URL: "https://api.example.com/mcp",
};

afterEach(() => {
  vi.restoreAllMocks();
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
});

describe("resolveRuntimeEnv", () => {
  it("returns the four required values", () => {
    expect(resolveRuntimeEnv(FULL_ENV)).toEqual({
      databaseUrl: "postgres://localhost/beevibe",
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-anthropic",
      mcpServerUrl: "https://api.example.com/mcp",
      workspaceRoot: undefined,
      skillsSourceDir: undefined,
    });
  });

  it("passes through the optional workspace + skills overrides", () => {
    const env = resolveRuntimeEnv({
      ...FULL_ENV,
      WORKSPACE_ROOT: "/srv/workspaces",
      BEEVIBE_SKILLS_DIR: "/srv/skills",
    });
    expect(env.workspaceRoot).toBe("/srv/workspaces");
    expect(env.skillsSourceDir).toBe("/srv/skills");
  });

  it("reports EVERY missing var in one throw, not just the first", () => {
    // The point of collecting rather than short-circuiting: an operator
    // bringing up a fresh deploy fixes one round of config instead of
    // one variable per restart.
    expect(() => resolveRuntimeEnv({})).toThrowError(
      /DATABASE_URL, OPENAI_API_KEY, ANTHROPIC_API_KEY, BEEVIBE_MCP_SERVER_URL/,
    );
  });

  it("treats an empty string as missing", () => {
    expect(() => resolveRuntimeEnv({ ...FULL_ENV, DATABASE_URL: "" })).toThrowError(
      /DATABASE_URL/,
    );
  });

  it("accepts the Railway fallback in place of an explicit MCP url", () => {
    const { BEEVIBE_MCP_SERVER_URL: _omitted, ...noMcp } = FULL_ENV;
    expect(resolveRuntimeEnv({ ...noMcp, RAILWAY_PUBLIC_DOMAIN: "beevibe.up.railway.app" }))
      .toMatchObject({ mcpServerUrl: "https://beevibe.up.railway.app/mcp" });
  });

  it("names BEEVIBE_MCP_SERVER_URL when neither it nor the Railway domain is set", () => {
    const { BEEVIBE_MCP_SERVER_URL: _omitted, ...noMcp } = FULL_ENV;
    expect(() => resolveRuntimeEnv(noMcp)).toThrowError(/BEEVIBE_MCP_SERVER_URL/);
  });
});

describe("installShutdownHandlers", () => {
  it("drains and exits 0 on SIGTERM", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const shutdown = vi.fn().mockResolvedValue(undefined);

    installShutdownHandlers("api", shutdown);
    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still exits 0 when shutdown throws", async () => {
    // A failed drain must not look like a crash: the handles are already
    // unusable, and a non-zero exit would make an orchestrator treat an
    // ordinary redeploy as a crash loop.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const shutdown = vi.fn().mockRejectedValue(new Error("pool already closed"));

    installShutdownHandlers("scheduler", shutdown);
    process.emit("SIGINT");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(exit).toHaveBeenCalledWith(0);
    expect(logged).toHaveBeenCalledWith("[scheduler] shutdown error:", expect.any(Error));
  });

  it("handles SIGINT and SIGTERM alike", async () => {
    // Stub process.exit so the handler doesn't take the test runner down;
    // the assertion is on shutdown, not on the exit call itself.
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const shutdown = vi.fn().mockResolvedValue(undefined);

    installShutdownHandlers("api", shutdown);
    process.emit("SIGINT");
    process.emit("SIGTERM");
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(2));
  });
});

describe("runEntrypoint", () => {
  it("exits 1 when main rejects", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    runEntrypoint("api", () => Promise.reject(new Error("Missing required env vars: X")));
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(exit).toHaveBeenCalledWith(1);
    expect(logged).toHaveBeenCalledWith("[api] fatal:", expect.any(Error));
  });

  it("does not exit when main resolves", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const main = vi.fn().mockResolvedValue(undefined);

    runEntrypoint("api", main);
    await vi.waitFor(() => expect(main).toHaveBeenCalled());

    expect(exit).not.toHaveBeenCalled();
  });
});
