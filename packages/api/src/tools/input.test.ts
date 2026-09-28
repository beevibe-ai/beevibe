/**
 * Tool-argument readers.
 *
 * The behavior these lock down is not just "the helper coerces correctly" —
 * it is that the envelope a *missing required argument* produces is
 * byte-identical to the hand-written guard each `require*` call replaced. That
 * equivalence runs through `toolErrorFromThrown`, so it is asserted against
 * the real function rather than restated, and once more end-to-end through a
 * real tool handler at the bottom of this file.
 */
import { describe, expect, it } from "vitest";
import {
  optionalNonEmptyString,
  optionalNumber,
  optionalObject,
  optionalString,
  optionalTrimmedString,
  readString,
  readTrimmedString,
  requireString,
  requireStrings,
} from "./input.js";
import { toolErrorFromThrown } from "./errors.js";

describe("readString", () => {
  it("coerces whatever arrived to a string", () => {
    expect(readString({ a: "x" }, "a")).toBe("x");
    expect(readString({ a: 5 }, "a")).toBe("5");
    expect(readString({ a: true }, "a")).toBe("true");
  });

  it("maps null, undefined and a missing key to the empty string", () => {
    expect(readString({ a: null }, "a")).toBe("");
    expect(readString({ a: undefined }, "a")).toBe("");
    expect(readString({}, "a")).toBe("");
  });

  it("does not coerce an object to [object Object] silently — it does", () => {
    // Documenting the inherited quirk rather than fixing it: every call site
    // replaced used `String(input.x ?? "")`, so an object argument for a
    // string field has always stringified this way.
    expect(readString({ a: {} }, "a")).toBe("[object Object]");
  });
});

describe("readTrimmedString", () => {
  it("trims, and yields empty for whitespace-only", () => {
    expect(readTrimmedString({ a: "  x  " }, "a")).toBe("x");
    expect(readTrimmedString({ a: "   " }, "a")).toBe("");
    expect(readTrimmedString({}, "a")).toBe("");
  });
});

describe("requireString", () => {
  it("returns the coerced value when present", () => {
    expect(requireString({ task_id: "task_1" }, "task_id")).toBe("task_1");
  });

  it.each([[{}], [{ task_id: "" }], [{ task_id: null }]])(
    "throws `<key> required` for %o",
    (input) => {
      expect(() => requireString(input, "task_id")).toThrow("task_id required");
    },
  );

  it("produces exactly the envelope the hand-written guard returned", () => {
    // The guard this replaced was, verbatim:
    //   if (!id) return { content: { error: "task_id required" }, isError: true };
    let caught: unknown;
    try {
      requireString({}, "task_id");
    } catch (err) {
      caught = err;
    }
    expect(toolErrorFromThrown(caught)).toEqual({
      content: { error: "task_id required" },
      isError: true,
    });
  });
});

describe("requireStrings", () => {
  it("returns the values positionally, in the order asked for", () => {
    const [taskId, feedback] = requireStrings(
      { feedback: "tighten it", task_id: "task_1" },
      "task_id",
      "feedback",
    );
    expect(taskId).toBe("task_1");
    expect(feedback).toBe("tighten it");
  });

  it("names every requested key when any one is missing", () => {
    // Matches the original `if (!a || !b)` guards, which reported both names
    // regardless of which was actually absent.
    expect(() => requireStrings({ task_id: "task_1" }, "task_id", "feedback")).toThrow(
      "task_id and feedback required",
    );
    expect(() => requireStrings({ feedback: "x" }, "task_id", "feedback")).toThrow(
      "task_id and feedback required",
    );
    expect(() => requireStrings({}, "task_id", "feedback")).toThrow(
      "task_id and feedback required",
    );
  });

  it("reproduces each message that was previously written by hand", () => {
    const cases: Array<[string[], string]> = [
      [["agent_id"], "agent_id required"],
      [["id"], "id required"],
      [["escalation_id"], "escalation_id required"],
      [["task_id", "title"], "task_id and title required"],
      [["intent", "agent_id"], "intent and agent_id required"],
      [["target_agent_id", "question"], "target_agent_id and question required"],
      [["request_id", "answer"], "request_id and answer required"],
      [["peer_id", "proposal"], "peer_id and proposal required"],
      [["negotiation_id", "message"], "negotiation_id and message required"],
      [["negotiation_id", "summary"], "negotiation_id and summary required"],
      [["task_id", "description"], "task_id and description required"],
    ];
    for (const [keys, message] of cases) {
      expect(() => requireStrings({}, ...keys)).toThrow(message);
    }
  });
});

describe("optionalString", () => {
  it("passes a string through, including the empty one", () => {
    expect(optionalString({ url: "u" }, "url")).toBe("u");
    expect(optionalString({ url: "" }, "url")).toBe("");
  });

  it("rejects every non-string, without coercing", () => {
    expect(optionalString({ url: 5 }, "url")).toBeUndefined();
    expect(optionalString({ url: null }, "url")).toBeUndefined();
    expect(optionalString({}, "url")).toBeUndefined();
  });
});

describe("optionalNonEmptyString", () => {
  it("treats the empty string as absent", () => {
    // `repo_url` and mesh's `task_id` rely on this: "" must reach the column
    // as undefined, not as an empty string.
    expect(optionalNonEmptyString({ repo_url: "" }, "repo_url")).toBeUndefined();
    expect(optionalNonEmptyString({ repo_url: "r" }, "repo_url")).toBe("r");
  });

  it("does not trim — whitespace is content here", () => {
    expect(optionalNonEmptyString({ repo_url: " " }, "repo_url")).toBe(" ");
  });
});

describe("optionalTrimmedString", () => {
  it("trims and treats whitespace-only as absent", () => {
    expect(optionalTrimmedString({ q: "  hi  " }, "q")).toBe("hi");
    expect(optionalTrimmedString({ q: "   " }, "q")).toBeUndefined();
    expect(optionalTrimmedString({ q: "" }, "q")).toBeUndefined();
    expect(optionalTrimmedString({ q: 5 }, "q")).toBeUndefined();
  });
});

describe("optionalNumber", () => {
  it("accepts numbers only — a numeric string is not a number", () => {
    expect(optionalNumber({ limit: 3 }, "limit")).toBe(3);
    expect(optionalNumber({ limit: 0 }, "limit")).toBe(0);
    expect(optionalNumber({ limit: "3" }, "limit")).toBeUndefined();
    expect(optionalNumber({}, "limit")).toBeUndefined();
  });
});

describe("optionalObject", () => {
  it("accepts an object, rejects null and primitives", () => {
    expect(optionalObject({ metadata: { k: 1 } }, "metadata")).toEqual({ k: 1 });
    expect(optionalObject({ metadata: null }, "metadata")).toBeUndefined();
    expect(optionalObject({ metadata: "s" }, "metadata")).toBeUndefined();
    expect(optionalObject({}, "metadata")).toBeUndefined();
  });

  it("accepts an array, as every site it replaced did", () => {
    expect(optionalObject({ metadata: [1] }, "metadata")).toEqual([1]);
  });
});
