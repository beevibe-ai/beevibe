import { describe, expect, it } from "vitest";
import {
  IN_FLIGHT_SESSION_STATUSES,
  SESSION_STATUSES,
  SESSION_TYPES,
  TERMINAL_SESSION_STATUSES,
  isInFlightSessionStatus,
  isTerminalSessionStatus,
} from "./session.js";

describe("isTerminalSessionStatus", () => {
  it("accepts every terminal status", () => {
    for (const s of TERMINAL_SESSION_STATUSES) {
      expect(isTerminalSessionStatus(s)).toBe(true);
    }
  });

  it("rejects pre-terminal statuses", () => {
    expect(isTerminalSessionStatus("pending")).toBe(false);
    expect(isTerminalSessionStatus("running")).toBe(false);
  });

  it("rejects non-status strings and non-strings", () => {
    // `/runtime/done` validates untrusted request bodies through this guard,
    // so the non-string cases are the ones that actually matter.
    expect(isTerminalSessionStatus("succeeded ")).toBe(false);
    expect(isTerminalSessionStatus("SUCCEEDED")).toBe(false);
    expect(isTerminalSessionStatus("")).toBe(false);
    expect(isTerminalSessionStatus(undefined)).toBe(false);
    expect(isTerminalSessionStatus(null)).toBe(false);
    expect(isTerminalSessionStatus(0)).toBe(false);
    expect(isTerminalSessionStatus(["succeeded"])).toBe(false);
    expect(isTerminalSessionStatus({ status: "succeeded" })).toBe(false);
  });
});

describe("isInFlightSessionStatus", () => {
  it("accepts every in-flight status", () => {
    for (const s of IN_FLIGHT_SESSION_STATUSES) {
      expect(isInFlightSessionStatus(s)).toBe(true);
    }
  });

  it("rejects terminal statuses", () => {
    for (const s of TERMINAL_SESSION_STATUSES) {
      expect(isInFlightSessionStatus(s)).toBe(false);
    }
  });

  it("rejects non-status strings and non-strings", () => {
    expect(isInFlightSessionStatus("run")).toBe(false);
    expect(isInFlightSessionStatus(null)).toBe(false);
    expect(isInFlightSessionStatus(7)).toBe(false);
  });
});

describe("session status constants", () => {
  it("terminal + in-flight partition the full status set", () => {
    const union = [
      ...TERMINAL_SESSION_STATUSES,
      ...IN_FLIGHT_SESSION_STATUSES,
    ].sort();
    expect(union).toEqual([...SESSION_STATUSES].sort());
  });

  it("terminal and in-flight sets are disjoint", () => {
    const terminal = new Set<string>(TERMINAL_SESSION_STATUSES);
    for (const s of IN_FLIGHT_SESSION_STATUSES) {
      expect(terminal.has(s)).toBe(false);
    }
  });

  it("exposes each session type exactly once", () => {
    expect(new Set(SESSION_TYPES).size).toBe(SESSION_TYPES.length);
    expect(SESSION_TYPES).toContain("task");
    expect(SESSION_TYPES).toContain("chat");
  });
});
