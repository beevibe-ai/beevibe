import { describe, expect, it } from "vitest";
import pg from "pg";
import { createPool } from "./client.js";

describe("createPool", () => {
  it("returns a pg.Pool instance built from the given connectionString", async () => {
    const pool = createPool({
      connectionString: "postgresql://noop@127.0.0.1:5/none",
    });
    try {
      expect(pool).toBeInstanceOf(pg.Pool);
      // Live options: pg.Pool exposes them on `.options`.
      expect(pool.options.connectionString).toBe(
        "postgresql://noop@127.0.0.1:5/none",
      );
    } finally {
      await pool.end();
    }
  });

  it("uses the documented default sizing when no overrides are given", async () => {
    const pool = createPool({
      connectionString: "postgresql://noop@127.0.0.1:5/none",
    });
    try {
      expect(pool.options.max).toBe(10);
      expect(pool.options.idleTimeoutMillis).toBe(30_000);
      expect(pool.options.connectionTimeoutMillis).toBe(5_000);
    } finally {
      await pool.end();
    }
  });

  it("propagates explicit overrides to pg.Pool", async () => {
    const pool = createPool({
      connectionString: "postgresql://noop@127.0.0.1:5/none",
      max: 3,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 250,
    });
    try {
      expect(pool.options.max).toBe(3);
      expect(pool.options.idleTimeoutMillis).toBe(1_000);
      expect(pool.options.connectionTimeoutMillis).toBe(250);
    } finally {
      await pool.end();
    }
  });
});
