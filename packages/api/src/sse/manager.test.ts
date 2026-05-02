import { describe, it, expect, vi } from "vitest";
import { SseManager, type BvEvent } from "./manager.js";

describe("SseManager", () => {
  it("delivers events only to subscribers whose personId is in the owner set", () => {
    const manager = new SseManager();
    const a = vi.fn();
    const b = vi.fn();
    manager.subscribe("person_a", a);
    manager.subscribe("person_b", b);

    const event: BvEvent = { event: "task.updated", id: "task_1" };
    manager.publish(event, new Set(["person_a"]));

    expect(a).toHaveBeenCalledWith(event);
    expect(b).not.toHaveBeenCalled();
  });

  it("multi-owner events fan out to all matching subscribers", () => {
    const manager = new SseManager();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    manager.subscribe("person_a", a);
    manager.subscribe("person_b", b);
    manager.subscribe("person_c", c);

    manager.publish(
      { event: "mesh.activity", id: "neg_1" },
      new Set(["person_a", "person_c"]),
    );

    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    expect(c).toHaveBeenCalledOnce();
  });

  it("drops events with empty owner set (fail-closed)", () => {
    const manager = new SseManager();
    const cb = vi.fn();
    manager.subscribe("person_a", cb);

    manager.publish({ event: "task.updated", id: "task_x" }, new Set());

    expect(cb).not.toHaveBeenCalled();
  });

  it("returns an unsubscribe handle that removes the callback", () => {
    const manager = new SseManager();
    const cb = vi.fn();
    const unsubscribe = manager.subscribe("person_a", cb);

    manager.publish({ event: "task.created", id: "t1" }, new Set(["person_a"]));
    unsubscribe();
    manager.publish({ event: "task.created", id: "t2" }, new Set(["person_a"]));

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

    manager.subscribe("person_a", failing);
    manager.subscribe("person_a", ok);
    manager.publish({ event: "agent.updated", id: "a1" }, new Set(["person_a"]));

    expect(failing).toHaveBeenCalledOnce();
    expect(ok).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("size() reflects current subscriber count across personIds", () => {
    const manager = new SseManager();
    expect(manager.size()).toBe(0);
    const u1 = manager.subscribe("person_a", () => {});
    manager.subscribe("person_b", () => {});
    expect(manager.size()).toBe(2);
    u1();
    expect(manager.size()).toBe(1);
  });
});
