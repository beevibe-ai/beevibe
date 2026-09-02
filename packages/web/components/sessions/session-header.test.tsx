import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { SessionHeader } from "./session-header";

describe("SessionHeader", () => {
  it("renders the title, the agent byline and its hierarchy chip", () => {
    render(
      <SessionHeader
        agentLabel="Ada"
        agentHierarchy="ic"
        status="running"
        title="Ship the parser"
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ship the parser");
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("ic")).toBeInTheDocument();
  });

  it("shows the session status, which both call sites also feed to the avatar", () => {
    render(
      <SessionHeader
        agentLabel="Ada"
        agentHierarchy="team"
        status="succeeded"
        title="One turn"
      />,
    );
    expect(screen.getByText("succeeded")).toBeInTheDocument();
  });

  it("renders the caller's trailing meta after the hierarchy chip", () => {
    render(
      <SessionHeader
        agentLabel="Ada"
        agentHierarchy="ic"
        status="succeeded"
        title="Conversation"
        meta={<span>3 turns</span>}
      />,
    );
    expect(screen.getByText("3 turns")).toBeInTheDocument();
  });

  it("omits the meta slot entirely when the caller passes none", () => {
    const { container } = render(
      <SessionHeader
        agentLabel="Ada"
        agentHierarchy="ic"
        status="succeeded"
        title="One turn"
      />,
    );
    expect(container.textContent).not.toContain("·");
  });
});
