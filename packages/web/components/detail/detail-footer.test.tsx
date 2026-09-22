import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DetailFooter, FooterField, MonoFooterField } from "./detail-footer";

describe("DetailFooter", () => {
  it("renders its fields inside a footer landmark", () => {
    render(
      <DetailFooter>
        <FooterField label="ID">abc123</FooterField>
      </DetailFooter>,
    );

    const footer = screen.getByRole("contentinfo");
    expect(footer.textContent).toContain("ID");
    expect(footer.textContent).toContain("abc123");
  });
});

describe("FooterField", () => {
  it("adds the truncation classes only when asked", () => {
    const { container, rerender } = render(<FooterField label="URL">https://x</FooterField>);
    expect(container.innerHTML).not.toContain("truncate");

    rerender(
      <FooterField label="URL" truncate>
        https://x
      </FooterField>,
    );
    expect(container.innerHTML).toContain("truncate");
  });
});

describe("MonoFooterField", () => {
  it("renders the value in mono when present", () => {
    render(<MonoFooterField label="Worktree" value="/tmp/wt" />);

    expect(screen.getByText("Worktree")).toBeTruthy();
    expect(screen.getByText("/tmp/wt").className).toContain("font-mono");
  });

  it("renders nothing for an absent value, so the grid keeps no empty cell", () => {
    for (const value of [null, undefined, ""]) {
      const { container } = render(<MonoFooterField label="CLI session" value={value} />);
      expect(container.firstChild).toBeNull();
    }
  });
});
