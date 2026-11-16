/**
 * Shared fixtures for the route unit tests.
 *
 * `stubAuth`, `stubPersonRepo` and `fakeAgent` were being redeclared in
 * file after file under `routes/`: `stubAuth` byte-for-byte in three of
 * them and differing only by which id it put in `req.caller` in two more,
 * `stubPersonRepo` byte-for-byte in three, and `fakeAgent` in six with the
 * same field list and different placeholder values.
 *
 * Mirrors `views/test-helpers.ts`, which did the same for the view
 * layer's mock pools, and `@beevibe/core`'s `auth/test-fakes.ts`. The
 * point is the same: when `Caller`, `PersonRepository` or `Agent` grows a
 * field, it should be one file to update rather than a search across
 * fifteen.
 */

import { vi } from "vitest";
import type express from "express";
import type { Agent, PersonRepository } from "@beevibe/core";

/** Default ids the fixtures agree on, so a test only names what it asserts. */
export const TEST_PERSON = "person_1";
export const TEST_AGENT = "agent_a";

/**
 * Auth middleware that plants a caller instead of checking a key.
 *
 * `"human"` is a person acting through their team agent, `"agent"` is an
 * IC agent calling with its own key, and `"none"` leaves `req.caller`
 * unset so the route's own `requireHuman` / `requireCaller` guard is what
 * gets exercised.
 */
export function stubAuth(
  source: "human" | "agent" | "none" = "human",
  ids: { agentId?: string; personId?: string } = {},
) {
  const agentId = ids.agentId ?? TEST_AGENT;
  const personId = ids.personId ?? TEST_PERSON;
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (source === "human") {
      req.caller = { source: "human", agentId, hierarchyLevel: "team", personId };
    } else if (source === "agent") {
      req.caller = { source: "agent", agentId, hierarchyLevel: "ic" };
    }
    next();
  };
}

/**
 * Full-surface `PersonRepository` of `vi.fn()`s. Pass `overrides` for the
 * one or two methods the test under way actually drives.
 */
export function stubPersonRepo(overrides: Partial<PersonRepository> = {}): PersonRepository {
  return {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findByApiKey: vi.fn(),
    findManyByIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

/**
 * A `team`-level `Agent` with every required field filled in.
 *
 * The timestamps are fixed rather than `new Date()` so a test can assert
 * on a serialized response body without reaching for fake timers.
 */
export function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: TEST_AGENT,
    name: "Ada's team",
    owner_id: TEST_PERSON,
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01T00:00:00Z"),
    updated_at: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  };
}
