import { describe, expect, it } from "vitest";
import type { Pool } from "./client.js";
import {
  buildPatchClause,
  findRowById,
  queryExpectOne,
  queryMany,
  queryOne,
  updateRowById,
} from "./pg-helpers.js";

interface WidgetRow {
  id: string;
  name: string;
  size: number | null;
}

interface Widget {
  id: string;
  name: string;
  size?: number;
}

interface WidgetPatch {
  name?: string;
  size?: number | null;
}

const rowToWidget = (row: WidgetRow): Widget => ({
  id: row.id,
  name: row.name,
  size: row.size ?? undefined,
});

interface Call {
  sql: string;
  params: unknown[];
}

/**
 * Minimal `Pool` stand-in: records every query and replays a canned rows
 * array per call. These helpers are pure SQL construction, so a real
 * Postgres would only slow the assertions down.
 */
function fakePool(responses: WidgetRow[][]) {
  const calls: Call[] = [];
  const pool = {
    query: (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return Promise.resolve({ rows: responses[calls.length - 1] ?? [] });
    },
  } as unknown as Pool;
  return { pool, calls };
}

const widgetRow: WidgetRow = { id: "w_1", name: "Sprocket", size: 3 };

const COLUMNS = { name: "name", size: "size" } as const;

describe("findRowById", () => {
  it("selects by id and maps the row", async () => {
    const { pool, calls } = fakePool([[widgetRow]]);
    const got = await findRowById(pool, "widget", "w_1", rowToWidget);
    expect(got).toEqual({ id: "w_1", name: "Sprocket", size: 3 });
    expect(calls[0]!.sql).toBe("SELECT * FROM widget WHERE id = $1 LIMIT 1");
    expect(calls[0]!.params).toEqual(["w_1"]);
  });

  it("returns undefined rather than mapping a missing row", async () => {
    const { pool } = fakePool([[]]);
    expect(await findRowById(pool, "widget", "nope", rowToWidget)).toBeUndefined();
  });
});

describe("updateRowById", () => {
  it("sets only the keys present in the patch", async () => {
    const { pool, calls } = fakePool([[{ ...widgetRow, name: "Cog" }]]);
    const got = await updateRowById<WidgetRow, WidgetPatch, Widget>({
      pool,
      table: "widget",
      id: "w_1",
      patch: { name: "Cog" },
      columns: COLUMNS,
      map: rowToWidget,
      notFound: (id) => `Widget not found: ${id}`,
    });
    expect(got.name).toBe("Cog");
    expect(calls[0]!.sql).toBe(
      "UPDATE widget SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    );
    expect(calls[0]!.params).toEqual(["Cog", "w_1"]);
  });

  it("writes an explicit null but skips an undefined", async () => {
    const { pool, calls } = fakePool([[{ ...widgetRow, size: null }]]);
    await updateRowById<WidgetRow, WidgetPatch, Widget>({
      pool,
      table: "widget",
      id: "w_1",
      patch: { name: undefined, size: null },
      columns: COLUMNS,
      map: rowToWidget,
      notFound: (id) => `Widget not found: ${id}`,
    });
    expect(calls[0]!.sql).toContain("SET size = $1");
    expect(calls[0]!.sql).not.toContain("name =");
    expect(calls[0]!.params).toEqual([null, "w_1"]);
  });

  it("omits updated_at for tables that don't carry the column", async () => {
    const { pool, calls } = fakePool([[widgetRow]]);
    await updateRowById<WidgetRow, WidgetPatch, Widget>({
      pool,
      table: "widget",
      id: "w_1",
      patch: { name: "Cog" },
      columns: COLUMNS,
      map: rowToWidget,
      notFound: (id) => `Widget not found: ${id}`,
      touchUpdatedAt: false,
    });
    expect(calls[0]!.sql).not.toContain("updated_at");
  });

  // An all-undefined patch would build `UPDATE widget SET  WHERE …`. The
  // helper degrades to a read instead of emitting that.
  it("degrades an empty patch to a read", async () => {
    const { pool, calls } = fakePool([[widgetRow]]);
    const got = await updateRowById<WidgetRow, WidgetPatch, Widget>({
      pool,
      table: "widget",
      id: "w_1",
      patch: {},
      columns: COLUMNS,
      map: rowToWidget,
      notFound: (id) => `Widget not found: ${id}`,
    });
    expect(got).toEqual({ id: "w_1", name: "Sprocket", size: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("SELECT");
  });

  it("throws on an empty patch for a row that doesn't exist", async () => {
    const { pool } = fakePool([[]]);
    await expect(
      updateRowById<WidgetRow, WidgetPatch, Widget>({
        pool,
        table: "widget",
        id: "gone",
        patch: {},
        columns: COLUMNS,
        map: rowToWidget,
        notFound: (id) => `Widget not found: ${id}`,
      }),
    ).rejects.toThrow("Widget not found: gone");
  });

  it("throws when the UPDATE matches no row", async () => {
    const { pool } = fakePool([[]]);
    await expect(
      updateRowById<WidgetRow, WidgetPatch, Widget>({
        pool,
        table: "widget",
        id: "gone",
        patch: { name: "Cog" },
        columns: COLUMNS,
        map: rowToWidget,
        notFound: (id) => `Widget not found: ${id}`,
      }),
    ).rejects.toThrow("Widget not found: gone");
  });
});

describe("buildPatchClause", () => {
  it("numbers placeholders in column-map order and reports the next index", () => {
    const clause = buildPatchClause<WidgetPatch>({ size: 5, name: "Cog" }, COLUMNS);
    expect(clause.fields).toEqual(["name = $1", "size = $2"]);
    expect(clause.values).toEqual(["Cog", 5]);
    expect(clause.nextIndex).toBe(3);
  });

  it("ignores patch keys with no column mapping", () => {
    const clause = buildPatchClause<WidgetPatch & { bogus?: string }>(
      { name: "Cog", bogus: "x" },
      COLUMNS,
    );
    expect(clause.fields).toEqual(["name = $1"]);
  });
});

describe("queryOne", () => {
  it("passes sql and params through and maps the first row", async () => {
    const { pool, calls } = fakePool([[widgetRow]]);
    const got = await queryOne(
      pool,
      "SELECT * FROM widget WHERE name = $1 LIMIT 1",
      ["Sprocket"],
      rowToWidget,
    );
    expect(got).toEqual({ id: "w_1", name: "Sprocket", size: 3 });
    expect(calls[0]!.sql).toBe("SELECT * FROM widget WHERE name = $1 LIMIT 1");
    expect(calls[0]!.params).toEqual(["Sprocket"]);
  });

  it("returns undefined — not a mapped empty row — when nothing matched", async () => {
    const { pool } = fakePool([[]]);
    const calledWith: WidgetRow[] = [];
    const got = await queryOne(pool, "SELECT 1", [], (row: WidgetRow) => {
      calledWith.push(row);
      return rowToWidget(row);
    });
    expect(got).toBeUndefined();
    // The mapper must not run at all on an empty result: several mappers
    // dereference row fields unconditionally.
    expect(calledWith).toEqual([]);
  });

  it("ignores rows past the first", async () => {
    const second: WidgetRow = { id: "w_2", name: "Cog", size: null };
    const { pool } = fakePool([[widgetRow, second]]);
    const got = await queryOne(pool, "SELECT 1", [], rowToWidget);
    expect(got).toEqual({ id: "w_1", name: "Sprocket", size: 3 });
  });
});

describe("queryMany", () => {
  it("maps every row in order", async () => {
    const second: WidgetRow = { id: "w_2", name: "Cog", size: null };
    const { pool, calls } = fakePool([[widgetRow, second]]);
    const got = await queryMany(pool, "SELECT * FROM widget", [], rowToWidget);
    expect(got).toEqual([
      { id: "w_1", name: "Sprocket", size: 3 },
      { id: "w_2", name: "Cog", size: undefined },
    ]);
    expect(calls[0]!.params).toEqual([]);
  });

  it("returns an empty array for an empty result", async () => {
    const { pool } = fakePool([[]]);
    expect(await queryMany(pool, "SELECT 1", [], rowToWidget)).toEqual([]);
  });
});

describe("queryExpectOne", () => {
  it("maps the single row", async () => {
    const { pool } = fakePool([[widgetRow]]);
    const got = await queryExpectOne(
      pool,
      "INSERT INTO widget (id) VALUES ($1) RETURNING *",
      ["w_1"],
      rowToWidget,
    );
    expect(got).toEqual({ id: "w_1", name: "Sprocket", size: 3 });
  });

  it("throws with a single-line SQL fragment when the result is empty", async () => {
    const { pool } = fakePool([[]]);
    await expect(
      queryExpectOne(
        pool,
        `INSERT INTO widget (id, name)
           VALUES ($1, $2)
           RETURNING *`,
        ["w_1", "Sprocket"],
        rowToWidget,
      ),
    ).rejects.toThrow(
      "Expected exactly one row from: INSERT INTO widget (id, name) VALUES ($1, $2) RETURNING *",
    );
  });
});
