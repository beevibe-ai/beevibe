import { describe, it, expect, vi } from "vitest";
import { SseManager, type BvEvent } from "./manager.js";

const event: BvEvent = { event: "task.updated", id: "task_1" };

describe("SseManager", () => {
  it("delivers events to subscribers whose personId is in the owner set", () => {
    const manager = new SseManager();
    const a = vi.fn();
    const b = vi.fn();
    manager.subscribe("person_a", a);
    manager.subscribe("person_b", b);

    manager.publish(event, new Set(["person_a", "person_b"]));

    expect(a).toHaveBeenCalledWith(event);
    expect(b).toHaveBeenCalledWith(event);
  });

  it("skips subscribers not in the owner set", () => {
    const manager = new SseManager();
    const a = vi.fn();
    const b = vi.fn();
    manager.subscribe("person_a", a);
    manager.subscribe("person_b", b);

    manager.publish(event, new Set(["person_a"]));

    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it("drops events with an empty owner set (fail-closed)", () => {
    const manager = new SseManager();
    const a = vi.fn();
    manager.subscribe("person_a", a);

    manager.publish(event, new Set());

    expect(a).not.toHaveBeenCalled();
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

  it("size() reflects current subscriber count", () => {
    const manager = new SseManager();
    expect(manager.size()).toBe(0);
    const u1 = manager.subscribe("person_a", () => {});
    manager.subscribe("person_b", () => {});
    expect(manager.size()).toBe(2);
    u1();
    expect(manager.size()).toBe(1);
  });

  it("delivers an event to the same subscriber once even when registered twice with same personId", () => {
    // The same person opening two browser tabs should get one delivery per
    // registered subscriber — and `subscribe` returns a per-call entry, so
    // two subscriptions with the same personId both fire.
    const manager = new SseManager();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    manager.subscribe("person_a", cb1);
    manager.subscribe("person_a", cb2);

    manager.publish(event, new Set(["person_a"]));

    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });
});
