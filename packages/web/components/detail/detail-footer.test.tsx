import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { DetailFooter, FooterLink } from "./detail-footer";
import { FooterField } from "./footer-field";

describe("DetailFooter", () => {
  it("renders the copyable id under the default label", () => {
    render(<DetailFooter id="task_42" />);
    expect(screen.getByText("ID")).toBeTruthy();
    expect(screen.getByText("task_42")).toBeTruthy();
  });

  it("labels the id per page when the noun differs", () => {
    render(<DetailFooter id="conv_7" idLabel="Conversation ID" />);
    expect(screen.getByText("Conversation ID")).toBeTruthy();
    // The default must not leak through alongside the override.
    expect(screen.queryByText("ID")).toBeNull();
  });

  it("renders the per-resource fields after the id", () => {
    const { container } = render(
      <DetailFooter id="task_42">
        <FooterField label="Priority">high</FooterField>
      </DetailFooter>,
    );
    const labels = [...container.querySelectorAll("footer > div > div:first-child")].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["ID", "Priority"]);
  });

  it("renders no extra cells when the page passes no fields", () => {
    const { container } = render(<DetailFooter id="task_42" />);
    expect(container.querySelectorAll("footer > div")).toHaveLength(1);
  });
});

describe("FooterLink", () => {
  it("links to the href in monospace", () => {
    render(<FooterLink href="/tasks/task_9">task_9</FooterLink>);
    const link = screen.getByRole("link", { name: "task_9" });
    expect(link.getAttribute("href")).toBe("/tasks/task_9");
    expect(link.className).toContain("font-mono");
  });
});
