/**
 * Shared mock-pool fixture for view-layer unit tests. Replaces five
 * near-identical local `makePool` helpers across `views/*.test.ts`.
 *
 * Two call shapes:
 *   - `makeMockPool([...rowsArray])` — returns the same rows for every
 *     query (used by single-query views like sessions/memory)
 *   - `makeMockPool([[rowsForQuery1], [rowsForQuery2], ...])` — ordered
 *     per-query responses (used by multi-query views like tasks/agents/
 *     dashboard, where each `pool.query()` gets the next array slot)
 */

import { vi, type Mock } from "vitest";
import type { Pool } from "@beevibe/core/adapters/postgres";

export type MockPool = Pool & { _spy: Mock };

function isMultiResponse(input: unknown[] | unknown[][]): input is unknown[][] {
  return input.length > 0 && Array.isArray(input[0]);
}

export function makeMockPool(input: unknown[] | unknown[][]): MockPool {
  if (isMultiResponse(input)) {
    let i = 0;
    const query = vi.fn(async () => ({ rows: input[i++] ?? [] }));
    return {
      query: query as unknown as Pool["query"],
      _spy: query,
    } as unknown as MockPool;
  }
  const query = vi.fn(async () => ({ rows: input }));
  return {
    query: query as unknown as Pool["query"],
    _spy: query,
  } as unknown as MockPool;
}
