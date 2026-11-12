import { describe, expect, it } from "vitest";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import { guardTool, guardTools, toolError, toolErrorFromThrown } from "./errors.js";
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

function throwingTool(err: unknown): AgentTool {
  return {
    name: "boom",
    description: "throws",
    schema: { type: "object" },
    handler: async () => {
      throw err;
    },
  };
}

describe("guardTool", () => {
  it("turns a thrown error into the toolErrorFromThrown envelope", async () => {
    const guarded = guardTool(throwingTool(new Error("kaboom")));
    await expect(guarded.handler({})).resolves.toEqual({
      content: { error: "kaboom" },
      isError: true,
    });
  });

  // The reason the guard lives in the builders and not only in
  // `routes/mcp.ts`: that route's catch flattens a coded error to its bare
  // message, losing the code agents branch on.
  it("keeps the code and meta of a coded mesh error", async () => {
    const coded = new MeshCapacityError("at cap", {
      agentId: "agent_1",
      running: 3,
      cap: 3,
    });
    const guarded = guardTool(throwingTool(coded));
    const result = await guarded.handler({});
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: coded.code,
      message: coded.message,
      ...coded.meta,
    });
  });

  it("passes a successful result straight through", async () => {
    const ok: AgentTool = {
      name: "ok",
      description: "fine",
      schema: { type: "object" },
      handler: async (input) => ({ content: { echo: input.x } }),
    };
    await expect(guardTool(ok).handler({ x: 1 })).resolves.toEqual({
      content: { echo: 1 },
    });
  });

  // A handler that already returns an error envelope (a validation reject)
  // must not be re-wrapped into the thrown shape.
  it("leaves a returned error envelope untouched", async () => {
    const rejects: AgentTool = {
      name: "rejects",
      description: "validates",
      schema: { type: "object" },
      handler: async () => toolError("bad_input", "query required"),
    };
    await expect(guardTool(rejects).handler({})).resolves.toEqual({
      content: { error: "bad_input", message: "query required" },
      isError: true,
    });
  });

  it("preserves name, description and schema", () => {
    const tool = throwingTool(new Error("x"));
    const guarded = guardTool(tool);
    expect(guarded.name).toBe(tool.name);
    expect(guarded.description).toBe(tool.description);
    expect(guarded.schema).toBe(tool.schema);
  });
});

describe("guardTools", () => {
  it("guards every tool in the array", async () => {
    const guarded = guardTools([
      throwingTool(new Error("one")),
      throwingTool(new Error("two")),
    ]);
    const results = await Promise.all(guarded.map((t) => t.handler({})));
    expect(results.map((r) => r.content.error)).toEqual(["one", "two"]);
  });
});
