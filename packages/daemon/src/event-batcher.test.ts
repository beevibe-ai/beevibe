import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api-client.js";
import { createEventBatcher, type BatchedEvent } from "./event-batcher.js";

function makeApi(post = vi.fn(async () => ({ status: 204, body: undefined }))) {
  return { api: { post } as unknown as ApiClient, post };
}

/** The `events` array of the nth POST body. */
function postedEvents(post: ReturnType<typeof vi.fn>, call = 0): BatchedEvent[] {
  return (post.mock.calls[call]?.[1] as { events: BatchedEvent[] }).events;
}

describe("createEventBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stamps session_id onto every event", async () => {
    const { api, post } = makeApi();
    const b = createEventBatcher({ api, sessionId: "sess_1", tag: "[t]" });

    b.push({ kind: "agent", content: "hello" });
    b.push({ kind: "tool_call", content: "Read(x)", tool_name: "Read" });
    await b.close();

    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith("/runtime/events", expect.anything());
    expect(postedEvents(post)).toEqual([
      { session_id: "sess_1", kind: "agent", content: "hello" },
      {
        session_id: "sess_1",
        kind: "tool_call",
        content: "Read(x)",
        tool_name: "Read",
      },
    ]);
  });

  it("holds events until the interval elapses, then posts them as one batch", async () => {
    const { api, post } = makeApi();
    const b = createEventBatcher({ api, sessionId: "sess_1", tag: "[t]" });

    b.push({ kind: "agent", content: "a" });
    b.push({ kind: "agent", content: "b" });
    expect(post).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(post).toHaveBeenCalledOnce();
    expect(postedEvents(post)).toHaveLength(2);
  });

  it("flushes immediately at the 16-event threshold without waiting", async () => {
    const { api, post } = makeApi();
    const b = createEventBatcher({ api, sessionId: "sess_1", tag: "[t]" });

    for (let i = 0; i < 16; i++) b.push({ kind: "agent", content: `e${i}` });

    // No timer advance — the threshold alone triggers the POST.
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledOnce();
    expect(postedEvents(post)).toHaveLength(16);
  });

  it("does not re-send events that were already flushed", async () => {
    const { api, post } = makeApi();
    const b = createEventBatcher({ api, sessionId: "sess_1", tag: "[t]" });

    b.push({ kind: "agent", content: "first" });
    await b.flush();
    b.push({ kind: "agent", content: "second" });
    await b.close();

    expect(post).toHaveBeenCalledTimes(2);
    expect(postedEvents(post, 0).map((e) => e.content)).toEqual(["first"]);
    expect(postedEvents(post, 1).map((e) => e.content)).toEqual(["second"]);
  });

  it("skips the POST entirely when there is nothing buffered", async () => {
    const { api, post } = makeApi();
    const b = createEventBatcher({ api, sessionId: "sess_1", tag: "[t]" });

    await b.close();
    expect(post).not.toHaveBeenCalled();
  });

  it("cancels the pending timer on flush so no empty POST follows", async () => {
    const { api, post } = makeApi();
    const b = createEventBatcher({ api, sessionId: "sess_1", tag: "[t]" });

    b.push({ kind: "agent", content: "a" });
    await b.flush();
    await vi.advanceTimersByTimeAsync(1000);

    expect(post).toHaveBeenCalledOnce();
  });

  it("swallows a failed POST — the run continues and events are dropped", async () => {
    const post = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const b = createEventBatcher({
      api: { post } as unknown as ApiClient,
      sessionId: "sess_1",
      tag: "[t]",
    });

    b.push({ kind: "agent", content: "a" });
    await expect(b.close()).resolves.toBeUndefined();

    // Dropped, not retried: the next flush carries only newer events.
    b.push({ kind: "agent", content: "b" });
    await b.close();
    expect(post).toHaveBeenCalledTimes(2);
  });
});
