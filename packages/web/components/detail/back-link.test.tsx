import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { BackLink } from "./back-link";

describe("BackLink", () => {
  it("renders an anchor to href, labelled by label", () => {
    render(<BackLink href="/agents" label="Agents" />);
    const link = screen.getByRole("link", { name: "Agents" });
    expect(link).toHaveAttribute("href", "/agents");
  });

  it("takes an interpolated href", () => {
    render(<BackLink href="/tasks/task_abc" label="Back to task" />);
    expect(screen.getByRole("link", { name: "Back to task" })).toHaveAttribute(
      "href",
      "/tasks/task_abc",
    );
  });

  it("carries the bottom margin when it is the page's whole nav", () => {
    render(<BackLink href="/mesh" label="Mesh" />);
    expect(screen.getByRole("link", { name: "Mesh" }).className).toContain("mb-3");
  });

  it("drops the bottom margin inside a breadcrumb row whose container owns the spacing", () => {
    render(<BackLink href="/memory" label="Memory" variant="inline" />);
    expect(screen.getByRole("link", { name: "Memory" }).className).not.toContain("mb-3");
  });

  it("keeps the muted type scale in both variants", () => {
    // The work-product breadcrumb has no text-xs/muted on its container and
    // relied on the link declaring them, so `inline` must not drop them.
    const { rerender } = render(<BackLink href="/a" label="A" />);
    expect(screen.getByRole("link", { name: "A" }).className).toContain(
      "text-xs text-muted-foreground",
    );
    rerender(<BackLink href="/a" label="A" variant="inline" />);
    expect(screen.getByRole("link", { name: "A" }).className).toContain(
      "text-xs text-muted-foreground",
    );
  });
});
