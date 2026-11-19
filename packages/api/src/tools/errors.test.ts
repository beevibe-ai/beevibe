import { describe, expect, it } from "vitest";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import { toolError, toolErrorFromThrown, withToolErrors } from "./errors.js";
import type { AgentTool } from "./types.js";

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

describe("withToolErrors", () => {
  function tool(handler: AgentTool["handler"]): AgentTool {
    return { name: "t", description: "d", schema: {}, handler };
  }

  it("passes a successful result through untouched", async () => {
    const wrapped = withToolErrors(tool(async () => ({ content: { ok: true } })));
    expect(await wrapped.handler({})).toEqual({ content: { ok: true } });
  });

  it("passes a handler's own error result through untouched", async () => {
    // A handler that reports failure by returning (not throwing) owns its
    // envelope; the wrapper must not rewrite it.
    const wrapped = withToolErrors(
      tool(async () => toolError("watch_auth", "not your task")),
    );
    expect(await wrapped.handler({})).toEqual({
      content: { error: "watch_auth", message: "not your task" },
      isError: true,
    });
  });

  it("envelopes a throw instead of letting it escape", async () => {
    const wrapped = withToolErrors(
      tool(() => {
        throw new Error("boom");
      }),
    );
    await expect(wrapped.handler({})).resolves.toEqual({
      content: { error: "boom" },
      isError: true,
    });
  });

  it("envelopes a rejected promise", async () => {
    const wrapped = withToolErrors(tool(() => Promise.reject(new Error("async boom"))));
    await expect(wrapped.handler({})).resolves.toEqual({
      content: { error: "async boom" },
      isError: true,
    });
  });

  it("preserves a coded mesh error's code and meta through the wrapper", async () => {
    // This is the gap the wrapper closes: the route-level catches flatten a
    // throw to `{ error: <message> }`, dropping the code agents branch on.
    const err = new MeshCapacityError("at cap", { agentId: "agent_1", running: 3, cap: 3 });
    const wrapped = withToolErrors(
      tool(() => {
        throw err;
      }),
    );
    const result = await wrapped.handler({});
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_1",
      running: 3,
      cap: 3,
    });
  });

  it("keeps the tool's name, description and schema", () => {
    const original = tool(async () => ({ content: {} }));
    original.description = "the real description";
    original.schema = { type: "object" };
    const wrapped = withToolErrors(original);
    expect(wrapped.name).toBe("t");
    expect(wrapped.description).toBe("the real description");
    expect(wrapped.schema).toEqual({ type: "object" });
  });

  it("forwards the input argument unchanged", async () => {
    let seen: unknown;
    const wrapped = withToolErrors(
      // eslint-disable-next-line @typescript-eslint/require-await
      tool(async (input) => {
        seen = input;
        return { content: {} };
      }),
    );
    await wrapped.handler({ task_id: "task_1" });
    expect(seen).toEqual({ task_id: "task_1" });
  });
});
