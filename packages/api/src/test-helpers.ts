/**
 * Shared fixtures for the route- and tool-level unit tests.
 *
 * These suites all stand a router (or a tool set) up over `vi.fn()` ports
 * and a stubbed caller, and each had hand-rolled the same three things:
 *
 *   - `stubAuth` — the auth middleware stand-in, five byte-identical
 *     copies differing only in which agent id they pinned.
 *   - `fakeAgent` — the `Agent` builder, five copies differing only in
 *     the id/name defaults.
 *   - `makeAgentRepo` / `makePersonRepo` — full-surface `vi.fn()` repos,
 *     byte-identical wherever they appeared.
 *
 * Sibling of `views/test-helpers.ts`, which did the same for the view
 * layer's `makePool`. Keeping the port surfaces here means adding a method
 * to `AgentRepository` or `PersonRepository` touches one file, not six.
 */

import { vi } from "vitest";
import type express from "express";
import type { Agent, AgentRepository, Person, PersonRepository } from "@beevibe/core";

/**
 * Which caller the stub installs. `"none"` leaves `req.caller` unset, so
 * the route's own human/agent gate is what rejects the request — that is
 * the branch these suites use it to reach.
 */
export type StubCallerSource = "human" | "agent" | "none";

/**
 * Build a suite's `stubAuth` with its ids bound once.
 *
 * Returns the middleware factory the suites already call as
 * `stubAuth()` / `stubAuth("agent")`, so call sites read the same as
 * before. A human caller is resolved at `team` level and an agent caller
 * at `ic`, which is the split every suite was using: the human branch
 * carries a `personId`, the agent branch deliberately does not.
 */
export function makeStubAuth(ids: { agentId: string; personId: string }) {
  return (source: StubCallerSource = "human"): express.RequestHandler =>
    (req, _res, next) => {
      if (source === "human") {
        req.caller = {
          source: "human",
          agentId: ids.agentId,
          hierarchyLevel: "team",
          personId: ids.personId,
        };
      } else if (source === "agent") {
        req.caller = { source: "agent", agentId: ids.agentId, hierarchyLevel: "ic" };
      }
      next();
    };
}

/**
 * Fixed timestamps. No suite asserts on an agent's `created_at` /
 * `updated_at` — they only need to be present and stable — so one epoch
 * serves all of them.
 */
const EPOCH = new Date("2026-01-01T00:00:00Z");

/**
 * Build a suite's `fakeAgent` with its defaults bound once.
 *
 * Three layers, innermost last: the base `Agent` shape here, the
 * per-suite defaults (its own ids and labels), then the per-call
 * overrides. Call sites keep the `fakeAgent({ ... })` shape they had.
 */
export function makeFakeAgent(defaults: Partial<Agent> = {}) {
  return (overrides: Partial<Agent> = {}): Agent => ({
    id: "agent_a",
    name: "Team",
    owner_id: "person_1",
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: EPOCH,
    updated_at: EPOCH,
    ...defaults,
    ...overrides,
  });
}

/**
 * Build a suite's `fakePerson` with its defaults bound once. Same three
 * layers as {@link makeFakeAgent}.
 *
 * `api_key` is deliberately absent from the base: the signin and signup
 * suites each pin their own, and `GET /me` serializes the person, so
 * handing every suite a key it did not ask for would change what that
 * route's tests see.
 */
export function makeFakePerson(defaults: Partial<Person> = {}) {
  return (overrides: Partial<Person> = {}): Person => ({
    id: "person_1",
    name: "Ada",
    email: "ada@example.com",
    capability_network_enabled: true,
    created_at: EPOCH,
    updated_at: EPOCH,
    ...defaults,
    ...overrides,
  });
}

/** Full-surface `AgentRepository` of `vi.fn()`s. */
export function makeAgentRepo(): AgentRepository {
  return {
    findById: vi.fn(),
    findByApiKey: vi.fn(),
    findTopLevelForOwner: vi.fn(),
    findSubordinates: vi.fn(),
    findPeers: vi.fn(),
    findParent: vi.fn(),
    findByLevel: vi.fn(),
    findDescendantIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

/** Full-surface `PersonRepository` of `vi.fn()`s. */
export function makePersonRepo(): PersonRepository {
  return {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findByApiKey: vi.fn(),
    findManyByIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}
