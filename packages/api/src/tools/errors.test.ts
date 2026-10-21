import { describe, expect, it } from "vitest";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import { defineTool, toolError, toolErrorFromThrown } from "./errors.js";
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

describe("defineTool", () => {
  const stub = (handler: AgentTool["handler"]): AgentTool => ({
    name: "stub",
    description: "stub",
    schema: { type: "object" },
    handler,
  });

  it("passes a successful result through untouched", async () => {
    const tool = defineTool(stub(async (input) => ({ content: { echo: input.q } })));
    await expect(tool.handler({ q: "hi" })).resolves.toEqual({
      content: { echo: "hi" },
    });
  });

  it("keeps name, description and schema", () => {
    const tool = defineTool(stub(async () => ({ content: {} })));
    expect(tool).toMatchObject({
      name: "stub",
      description: "stub",
      schema: { type: "object" },
    });
  });

  it("envelopes a throw instead of rejecting", async () => {
    const tool = defineTool(stub(async () => {
      throw new Error("boom");
    }));
    await expect(tool.handler({})).resolves.toEqual({
      content: { error: "boom" },
      isError: true,
    });
  });

  it("preserves a coded mesh error's code and meta", async () => {
    const err = new MeshCapacityError("at cap", { agentId: "agent_1", running: 3, cap: 3 });
    const tool = defineTool(stub(async () => {
      throw err;
    }));
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: err.code, ...err.meta });
  });

  it("routes the throw through a caller-supplied mapper", async () => {
    const tool = defineTool(
      stub(async () => {
        throw new Error("nope");
      }),
      () => toolError("watch_error", "mapped"),
    );
    await expect(tool.handler({})).resolves.toEqual({
      content: { error: "watch_error", message: "mapped" },
      isError: true,
    });
  });

  it("envelopes a non-async handler that throws at the call site", async () => {
    // A non-async handler throws synchronously instead of returning a
    // rejected promise. The call sits inside the try, so the same catch
    // covers both.
    const tool = defineTool(
      stub((() => {
        throw new Error("sync boom");
      }) as unknown as AgentTool["handler"]),
    );
    await expect(tool.handler({})).resolves.toEqual({
      content: { error: "sync boom" },
      isError: true,
    });
  });
});
