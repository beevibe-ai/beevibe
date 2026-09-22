import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetaDot, SessionDetailHeader } from "./session-header";

describe("SessionDetailHeader", () => {
  it("renders the title, status pill and agent label", () => {
    render(
      <SessionDetailHeader
        agentLabel="Ada"
        agentHierarchy="ic"
        status="succeeded"
        title="Fix the parser"
      />,
    );

    expect(screen.getByRole("heading", { name: "Fix the parser" })).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("succeeded")).toBeTruthy();
  });

  it("marks the avatar as running only while the session runs", () => {
    const { container, rerender } = render(
      <SessionDetailHeader
        agentLabel="Ada"
        agentHierarchy="team"
        status="running"
        title="Conversation"
      />,
    );
    const breathing = container.querySelectorAll(".animate-pulse-breathe").length;

    rerender(
      <SessionDetailHeader
        agentLabel="Ada"
        agentHierarchy="team"
        status="failed"
        title="Conversation"
      />,
    );

    expect(breathing).toBeGreaterThan(0);
    expect(container.querySelectorAll(".animate-pulse-breathe").length).toBe(0);
  });

  it("renders the caller's meta slot after the hierarchy chip", () => {
    render(
      <SessionDetailHeader
        agentLabel="Ada"
        agentHierarchy="ic"
        status="succeeded"
        title="Conversation"
        meta={
          <>
            <MetaDot />
            <span>3 turns</span>
          </>
        }
      />,
    );

    expect(screen.getByText("3 turns")).toBeTruthy();
  });

  it("applies both headings' styling, which the two pages had drifted on", () => {
    // One page's h1 carried `tracking-tight`, the other `truncate`; the
    // shared header applies both so they render alike.
    render(
      <SessionDetailHeader
        agentLabel="Ada"
        agentHierarchy="ic"
        status="succeeded"
        title="A very long session intent that would otherwise overflow"
      />,
    );

    const heading = screen.getByRole("heading");
    expect(heading.className).toContain("tracking-tight");
    expect(heading.className).toContain("truncate");
  });
});
