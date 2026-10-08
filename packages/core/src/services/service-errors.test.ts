import { describe, expect, it } from "vitest";
import { defineNotFoundError, defineServiceError } from "./service-errors.js";
import { InvalidTaskTransitionError, TaskNotFoundError } from "./task-service.js";
import {
  EscalationNotFoundError,
  EscalationStateError,
  NotPartyError,
} from "./escalation-service.js";
import { NegotiationNotFoundError } from "./negotiation-service.js";
import { WatchAuthError, WatchNotFoundError, WatchValidationError } from "./watch-service.js";

describe("defineServiceError", () => {
  const Boom = defineServiceError("Boom", "BOOM");

  it("passes the message through and names the instance", () => {
    const e = new Boom("it broke");
    expect(e.message).toBe("it broke");
    expect(e.name).toBe("Boom");
    expect(e).toBeInstanceOf(Error);
  });

  it("names the class itself, so a stack trace reads like a declared class", () => {
    expect(Boom.name).toBe("Boom");
    expect(new Boom("x").stack?.split("\n")[0]).toBe("Boom: x");
    expect(new Boom("x").toString()).toBe("Boom: x");
  });

  it("exposes `code` when given one", () => {
    expect(new Boom("x").code).toBe("BOOM");
  });

  it("omits the `code` property entirely when not given one", () => {
    const Bare = defineServiceError("Bare");
    const e = new Bare("x");
    expect(e.code).toBeUndefined();
    // Not merely undefined — absent, as in the three hand-written Watch*
    // classes that never declared a code.
    expect(Object.prototype.hasOwnProperty.call(e, "code")).toBe(false);
    expect(JSON.stringify(e)).toBe(`{"name":"Bare"}`);
  });

  it("reproduces a `readonly code = …` class field's own-property descriptor", () => {
    // `readonly` is compile-time only, so the runtime field is writable, and
    // a field initializer runs before the constructor body — hence `code`
    // precedes `name` in insertion order.
    const e = new Boom("x");
    expect(Object.getOwnPropertyDescriptor(e, "code")).toEqual({
      value: "BOOM",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(Object.keys(e)).toEqual(["code", "name"]);
  });

  it("builds a distinct class per call, so instanceof still discriminates", () => {
    const A = defineServiceError("A");
    const B = defineServiceError("B");
    expect(new A("x")).toBeInstanceOf(A);
    expect(new A("x")).not.toBeInstanceOf(B);
  });
});

describe("defineNotFoundError", () => {
  const Missing = defineNotFoundError("Missing", "Widget", "MISSING");

  it("formats `<label> <id> not found`", () => {
    expect(new Missing("w_1").message).toBe("Widget w_1 not found");
    expect(new Missing("w_1").name).toBe("Missing");
    expect(new Missing("w_1").code).toBe("MISSING");
  });

  it("takes the label verbatim, including a non-capitalized table name", () => {
    const W = defineNotFoundError("W", "task_watch");
    expect(new W("tw_1").message).toBe("task_watch tw_1 not found");
  });
});

/**
 * The nine classes the factories replaced. These assert the exact strings and
 * codes the hand-written versions produced — the routes and MCP tools branch
 * on `instanceof` and surface `.message` to clients, so both are contract.
 */
describe("the service errors built by the factories", () => {
  const notFound = [
    [TaskNotFoundError, "t_1", "Task t_1 not found", "TaskNotFoundError", "TASK_NOT_FOUND"],
    [
      EscalationNotFoundError,
      "e_1",
      "Escalation e_1 not found",
      "EscalationNotFoundError",
      "ESCALATION_NOT_FOUND",
    ],
    [
      NegotiationNotFoundError,
      "n_1",
      "Negotiation n_1 not found",
      "NegotiationNotFoundError",
      "NEGOTIATION_NOT_FOUND",
    ],
    // The one that names the table rather than a display noun.
    [WatchNotFoundError, "w_1", "task_watch w_1 not found", "WatchNotFoundError", undefined],
  ] as const;

  it.each(notFound)("%o formats its id and keeps its code", (Cls, id, message, name, code) => {
    const e = new Cls(id);
    expect(e.message).toBe(message);
    expect(e.name).toBe(name);
    expect(e.code).toBe(code);
    expect(e).toBeInstanceOf(Error);
  });

  const passthrough = [
    [InvalidTaskTransitionError, "InvalidTaskTransitionError", "INVALID_TASK_TRANSITION"],
    [EscalationStateError, "EscalationStateError", "ESCALATION_STATE_ERROR"],
    [NotPartyError, "NotPartyError", "NOT_PARTY"],
    // The Watch* pair never declared a code; preserved as-is.
    [WatchAuthError, "WatchAuthError", undefined],
    [WatchValidationError, "WatchValidationError", undefined],
  ] as const;

  it.each(passthrough)("%o passes its message through and keeps its code", (Cls, name, code) => {
    const e = new Cls("because reasons");
    expect(e.message).toBe("because reasons");
    expect(e.name).toBe(name);
    expect(e.code).toBe(code);
  });

  it("keeps all nine mutually exclusive under instanceof", () => {
    const all = [
      new TaskNotFoundError("t"),
      new InvalidTaskTransitionError("m"),
      new EscalationNotFoundError("e"),
      new EscalationStateError("m"),
      new NotPartyError("m"),
      new NegotiationNotFoundError("n"),
      new WatchAuthError("m"),
      new WatchValidationError("m"),
      new WatchNotFoundError("w"),
    ];
    const classes = [
      TaskNotFoundError,
      InvalidTaskTransitionError,
      EscalationNotFoundError,
      EscalationStateError,
      NotPartyError,
      NegotiationNotFoundError,
      WatchAuthError,
      WatchValidationError,
      WatchNotFoundError,
    ];
    all.forEach((e, i) => {
      classes.forEach((Cls, j) => {
        expect(e instanceof Cls).toBe(i === j);
      });
    });
  });
});
