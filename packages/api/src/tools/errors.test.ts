import { describe, expect, it } from "vitest";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import { safeHandler, toolError, toolErrorFromThrown } from "./errors.js";

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

describe("safeHandler", () => {
  it("passes a successful result through untouched", async () => {
    const wrapped = safeHandler(async (input) => ({ content: { echo: input.q } }));
    await expect(wrapped({ q: "hi" })).resolves.toEqual({ content: { echo: "hi" } });
  });

  it("preserves a handler's own isError result rather than re-wrapping it", async () => {
    const wrapped = safeHandler(async () => ({
      content: { error: "query must be a non-empty string" },
      isError: true,
    }));
    await expect(wrapped({})).resolves.toEqual({
      content: { error: "query must be a non-empty string" },
      isError: true,
    });
  });

  it("converts a rejected promise into the catch-all envelope", async () => {
    const wrapped = safeHandler(async () => {
      throw new Error("db down");
    });
    await expect(wrapped({})).resolves.toEqual({
      content: { error: "db down" },
      isError: true,
    });
  });

  it("keeps the code and meta of a coded mesh error", async () => {
    const wrapped = safeHandler(async () => {
      throw new MeshCapacityError("at cap", { agentId: "agent_1", running: 3, cap: 3 });
    });
    const result = await wrapped({});
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "MESH_CAPACITY_EXCEEDED", agentId: "agent_1" });
  });

  it("catches a synchronous throw from the handler body", async () => {
    // The frame this replaced was an inline `try` around the body, so a
    // throw before the first `await` was caught too. A wrapper that only
    // attached `.catch()` to the returned promise would miss this.
    const wrapped = safeHandler((() => {
      throw new Error("sync boom");
    }) as unknown as Parameters<typeof safeHandler>[0]);
    await expect(wrapped({})).resolves.toEqual({
      content: { error: "sync boom" },
      isError: true,
    });
  });
});
