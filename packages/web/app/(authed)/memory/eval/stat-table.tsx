import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The read-only stats table this page renders five times over five
 * different row types.
 *
 * Each copy was the same thirty lines — the same `thead` tint, the same
 * `border-b border-border/40` header rule, the same
 * `border-b border-border/20 last:border-0` body rule, the same
 * `py-1.5` cell padding — with only the column headers and the cell
 * expressions differing. Describing a table as a column list makes the
 * per-table code the part that is actually per-table, and means a change
 * to the row rules lands on all five at once instead of four out of
 * five.
 *
 * Deliberately local to this page. The idiom does not appear anywhere
 * else in the app (`memory-client` and `agents-list-view` are the only
 * other `<thead>`s in the tree and both style their rows differently),
 * so promoting it to `components/` would be inventing a design-system
 * table on the strength of a single page.
 */
export interface StatColumn<T> {
  header: string;
  /** Numeric columns are right-aligned; the default is left. */
  align?: "left" | "right";
  cell: (row: T) => ReactNode;
  /** Extra `<td>` classes — muted tone, truncation width, emphasis. */
  cellClassName?: string;
}

export function StatTable<T>({
  rows,
  columns,
  rowKey,
  empty,
}: {
  rows: readonly T[];
  columns: ReadonlyArray<StatColumn<T>>;
  rowKey: (row: T) => string;
  /** Shown in place of the table when there is nothing to list. */
  empty: ReactNode;
}) {
  if (rows.length === 0) {
    return <div className="text-xs text-muted-foreground py-4 text-center">{empty}</div>;
  }
  return (
    <table className="w-full text-xs">
      <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
        <tr className="border-b border-border/40">
          {columns.map((col) => (
            <th
              key={col.header}
              className={cn("py-1.5", col.align === "right" ? "text-right" : "text-left")}
            >
              {col.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {rows.map((row) => (
          <tr key={rowKey(row)} className="border-b border-border/20 last:border-0">
            {columns.map((col) => (
              <td
                key={col.header}
                className={cn(
                  "py-1.5",
                  col.align === "right" && "text-right",
                  col.cellClassName,
                )}
              >
                {col.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
