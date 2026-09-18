import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ErrorPanel, InlineError } from "./error-display";

describe("InlineError", () => {
  it("renders the message it is given", () => {
    render(<InlineError message="Email or password is incorrect." />);
    expect(screen.getByText("Email or password is incorrect.")).toBeTruthy();
  });

  it("appends the caller's spacing without dropping the base styling", () => {
    // Every call site differs only in outer margin — under a field it's mt-2
    // or mt-3, above a list it's mb-4 — so the base has to survive the merge.
    const { container } = render(<InlineError message="boom" className="mb-4" />);
    const row = container.firstElementChild!;
    expect(row.className).toContain("mb-4");
    expect(row.className).toContain("text-status-failed");
  });

  it("lets a caller box it without a second component", () => {
    // /welcome wraps the same row in a bordered card. `cn` merging means that
    // is a className, not a variant.
    const { container } = render(
      <InlineError message="boom" className="rounded-md border p-3" />,
    );
    expect(container.firstElementChild!.className).toContain("rounded-md");
  });
});

describe("ErrorPanel", () => {
  it("shows the headline and the underlying error text", () => {
    render(<ErrorPanel title="Couldn't send" detail="502 Bad Gateway" />);
    expect(screen.getByText("Couldn't send")).toBeTruthy();
    expect(screen.getByText("502 Bad Gateway")).toBeTruthy();
  });

  it("omits the detail row entirely when there is no detail", () => {
    render(<ErrorPanel title="Couldn't send" />);
    expect(screen.queryByText("502 Bad Gateway")).toBeNull();
  });

  it("merges the caller's spacing class", () => {
    const { container } = render(<ErrorPanel title="x" className="mt-4" />);
    expect(container.firstElementChild!.className).toContain("mt-4");
  });
});
