import { describe, expect, it } from "vitest";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import { guardToolHandlers, toolError, toolErrorFromThrown } from "./errors.js";
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

describe("guardToolHandlers", () => {
  function tool(handler: AgentTool["handler"]): AgentTool {
    return { name: "t", description: "d", schema: {}, handler };
  }

  it("envelopes a throw instead of letting it escape the handler", async () => {
    const [guarded] = guardToolHandlers([
      tool(async () => {
        throw new Error("boom");
      }),
    ]);
    await expect(guarded!.handler({})).resolves.toEqual({
      content: { error: "boom" },
      isError: true,
    });
  });

  it("preserves a CodedMeshError's code and meta through the guard", async () => {
    // This is the whole point of guarding: without it the throw reaches the
    // MCP transport's generic catch, which flattens to `{ error: <message> }`
    // and strips the code the calling agent branches on.
    const [guarded] = guardToolHandlers([
      tool(async () => {
        throw new MeshCapacityError("at cap", {
          agentId: "agent_1",
          running: 3,
          cap: 3,
        });
      }),
    ]);
    await expect(guarded!.handler({})).resolves.toEqual({
      content: {
        error: "MESH_CAPACITY_EXCEEDED",
        agentId: "agent_1",
        running: 3,
        cap: 3,
        message: "at cap",
      },
      isError: true,
    });
  });

  it("passes a successful result through untouched", async () => {
    const [guarded] = guardToolHandlers([
      tool(async (input) => ({ content: { echoed: input.q } })),
    ]);
    await expect(guarded!.handler({ q: "hi" })).resolves.toEqual({
      content: { echoed: "hi" },
    });
  });

  it("leaves a returned error envelope alone — it only catches throws", async () => {
    const envelope = { content: { error: "invalid_goal" }, isError: true };
    const [guarded] = guardToolHandlers([tool(async () => envelope)]);
    await expect(guarded!.handler({})).resolves.toEqual(envelope);
  });

  it("keeps name, description and schema, and guards every tool in the list", async () => {
    const guarded = guardToolHandlers([
      { name: "a", description: "da", schema: { type: "object" }, handler: async () => {
        throw new Error("a failed");
      } },
      { name: "b", description: "db", schema: {}, handler: async () => {
        throw new Error("b failed");
      } },
    ]);
    expect(guarded.map((t) => t.name)).toEqual(["a", "b"]);
    expect(guarded[0]!.description).toBe("da");
    expect(guarded[0]!.schema).toEqual({ type: "object" });
    expect((await guarded[0]!.handler({})).content.error).toBe("a failed");
    expect((await guarded[1]!.handler({})).content.error).toBe("b failed");
  });

  it("lets an inner guard win when a handler keeps its own catch", async () => {
    // `revise_task` still wraps its own body to map
    // InvalidTaskTransitionError onto a named code; double-wrapping must
    // not clobber that.
    const [guarded] = guardToolHandlers([
      tool(async () => {
        try {
          throw new Error("inner");
        } catch {
          return { content: { error: "invalid_transition" }, isError: true };
        }
      }),
    ]);
    expect((await guarded!.handler({})).content.error).toBe("invalid_transition");
  });
});
