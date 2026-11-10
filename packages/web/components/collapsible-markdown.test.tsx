import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

import { CollapsibleMarkdown } from "./collapsible-markdown";

describe("CollapsibleMarkdown", () => {
  it("renders short content in full, with no Show more", () => {
    render(<CollapsibleMarkdown content="just a line" threshold={100} />);
    expect(screen.getByText("just a line")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("truncates past the threshold and offers Show more", () => {
    render(<CollapsibleMarkdown content={"a".repeat(50)} threshold={10} />);
    expect(screen.getByText("aaaaaaaaaa…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument();
  });

  it("reveals the full content on Show more, then drops the button", async () => {
    const content = "x".repeat(20) + " tail";
    render(<CollapsibleMarkdown content={content} threshold={10} />);
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText(content)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("trims trailing whitespace before the ellipsis", () => {
    render(<CollapsibleMarkdown content={"abc        def"} threshold={5} />);
    expect(screen.getByText("abc…")).toBeInTheDocument();
  });

  it("treats content exactly at the threshold as short", () => {
    render(<CollapsibleMarkdown content={"b".repeat(10)} threshold={10} />);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("applies the default prose class, and an override when given", () => {
    const { container, unmount } = render(
      <CollapsibleMarkdown content="hi" threshold={100} />,
    );
    expect(container.querySelector("div")).toHaveClass("text-foreground/85");
    unmount();
    const second = render(
      <CollapsibleMarkdown content="hi" threshold={100} className="text-sm custom" />,
    );
    expect(second.container.querySelector("div")).toHaveClass("text-sm", "custom");
  });
});
