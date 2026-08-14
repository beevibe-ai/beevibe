import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatTable } from "./stat-table";

interface Row {
  id: string;
  name: string;
  writes: number;
}

const ROWS: Row[] = [
  { id: "a", name: "Ada", writes: 1234 },
  { id: "b", name: "Grace", writes: 7 },
];

const COLUMNS = [
  { header: "Agent", cell: (r: Row) => r.name },
  { header: "Writes", align: "right" as const, cell: (r: Row) => r.writes },
];

describe("StatTable", () => {
  it("renders one header per column and one row per item", () => {
    render(<StatTable rows={ROWS} columns={COLUMNS} rowKey={(r) => r.id} empty="none" />);
    expect(screen.getByRole("columnheader", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Writes" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 body rows
    expect(screen.getByText("Grace")).toBeInTheDocument();
  });

  it("right-aligns both the header and the cells of a right column", () => {
    render(<StatTable rows={ROWS} columns={COLUMNS} rowKey={(r) => r.id} empty="none" />);
    expect(screen.getByRole("columnheader", { name: "Writes" }).className).toContain(
      "text-right",
    );
    expect(screen.getByText("1234").className).toContain("text-right");
  });

  it("shows the empty node instead of a table when there are no rows", () => {
    render(
      <StatTable rows={[]} columns={COLUMNS} rowKey={(r) => r.id} empty="Nothing yet." />,
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing yet.")).toBeInTheDocument();
  });

  it("appends per-column cell classes on top of the shared padding", () => {
    render(
      <StatTable
        rows={ROWS}
        columns={[
          { header: "Agent", cell: (r: Row) => r.name, cellClassName: "font-semibold" },
        ]}
        rowKey={(r) => r.id}
        empty="none"
      />,
    );
    const cell = screen.getByText("Ada");
    expect(cell.className).toContain("font-semibold");
    expect(cell.className).toContain("py-1.5");
  });
});
