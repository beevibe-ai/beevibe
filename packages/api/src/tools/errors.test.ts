import { describe, expect, it } from "vitest";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import { guarded, toolError, toolErrorFromThrown } from "./errors.js";

describe("toolError", () => {
  it("puts the code in `error` and the human text in `message`", () => {
    expect(toolError("watch_auth", "not your task")).toEqual({
      content: { error: "watch_auth", message: "not your task" },
      isError: true,
    });
  });

  it("merges structured context alongside code and message", () => {
    expect(toolError("watch_validation", "bad mode", { mode: "nope" })).toEqual({
      content: { error: "watch_validation", message: "bad mode", mode: "nope" },
      isError: true,
    });
  });
});

describe("toolErrorFromThrown", () => {
  it("preserves the code and meta of every coded mesh error", () => {
    const coded = [
      new MeshCapacityError("at cap", { agentId: "agent_1", running: 3, cap: 3 }),
      new MeshMaxRoundsError({
        negotiationId: "neg_1",
        rounds_completed: 5,
        max_rounds: 5,
      }),
      new CannotNegotiateWithIcError({ agentId: "agent_2" }),
    ];

    for (const err of coded) {
      const result = toolErrorFromThrown(err);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: err.code,
        message: err.message,
        ...err.meta,
      });
    }
  });

  it("reports an uncoded Error by its message, in the `error` field", () => {
    expect(toolErrorFromThrown(new Error("boom"))).toEqual({
      content: { error: "boom" },
      isError: true,
    });
  });

  it("stringifies a non-Error throw", () => {
    expect(toolErrorFromThrown("just a string")).toEqual({
      content: { error: "just a string" },
      isError: true,
    });
  });

  it("merges `extra` into the uncoded envelope", () => {
    expect(toolErrorFromThrown(new Error("boom"), { agent_id: "agent_1" })).toEqual({
      content: { error: "boom", agent_id: "agent_1" },
      isError: true,
    });
  });

  it("does not treat a plain object with a `code` as a coded error", () => {
    // Guards the coded branch against duck-typing: pg and node fs errors
    // carry a `code` too, and must not be reported as a mesh code.
    const pgLike = Object.assign(new Error("duplicate key"), { code: "23505" });
    expect(toolErrorFromThrown(pgLike).content).toEqual({ error: "duplicate key" });
  });
});

describe("guarded", () => {
  it("passes a successful result straight through", async () => {
    const handler = guarded(async (input) => ({ content: { echo: input.q } }));
    await expect(handler({ q: "hi" })).resolves.toEqual({ content: { echo: "hi" } });
  });

  it("passes a handler's own error result through untouched", async () => {
    // A tool that *returns* an error envelope (validation rejection) must not
    // have it rewritten — only a throw is the wrapper's business.
    const handler = guarded(async () => toolError("invalid_goal", "goal required"));
    await expect(handler({})).resolves.toEqual({
      content: { error: "invalid_goal", message: "goal required" },
      isError: true,
    });
  });

  it("turns a thrown Error into the catch-all envelope", async () => {
    const handler = guarded(async () => {
      throw new Error("boom");
    });
    await expect(handler({})).resolves.toEqual({
      content: { error: "boom" },
      isError: true,
    });
  });

  it("keeps a coded mesh error's code and meta", async () => {
    // This is why the wrapper exists rather than leaning on the catch in
    // `routes/mcp.ts`: that one flattens a coded error to its message.
    const handler = guarded(async () => {
      throw new MeshCapacityError("at cap", { agentId: "agent_1", running: 3, cap: 3 });
    });
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_1",
      running: 3,
      cap: 3,
    });
  });

  it("catches a synchronous throw from the handler body", async () => {
    // An `async` function body that throws before its first await still
    // rejects rather than throwing synchronously, but a handler written as a
    // plain function would throw — the wrapper must cover both.
    const handler = guarded((() => {
      throw new Error("sync boom");
    }) as Parameters<typeof guarded>[0]);
    await expect(handler({})).resolves.toEqual({
      content: { error: "sync boom" },
      isError: true,
    });
  });
});
