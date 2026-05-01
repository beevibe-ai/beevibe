import { describe, it, expect, vi } from "vitest";
import { SseManager, type BvEvent } from "./manager.js";

describe("SseManager", () => {
  it("delivers published events to all subscribers", () => {
    const manager = new SseManager();
    const a = vi.fn();
    const b = vi.fn();
    manager.subscribe(a);
    manager.subscribe(b);

    const event: BvEvent = { event: "task.updated", id: "task_1" };
    manager.publish(event);

    expect(a).toHaveBeenCalledWith(event);
    expect(b).toHaveBeenCalledWith(event);
  });

  it("returns an unsubscribe handle that removes the callback", () => {
    const manager = new SseManager();
    const cb = vi.fn();
    const unsubscribe = manager.subscribe(cb);

    manager.publish({ event: "task.created", id: "t1" });
    unsubscribe();
    manager.publish({ event: "task.created", id: "t2" });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(manager.size()).toBe(0);
  });

  it("isolates one subscriber's throw from the rest", () => {
    const manager = new SseManager();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = vi.fn(() => {
      throw new Error("oops");
    });
    const ok = vi.fn();

    manager.subscribe(failing);
    manager.subscribe(ok);
    manager.publish({ event: "agent.updated", id: "a1" });

    expect(failing).toHaveBeenCalledOnce();
    expect(ok).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("size() reflects current subscriber count", () => {
    const manager = new SseManager();
    expect(manager.size()).toBe(0);
    const u1 = manager.subscribe(() => {});
    manager.subscribe(() => {});
    expect(manager.size()).toBe(2);
    u1();
    expect(manager.size()).toBe(1);
  });
});
