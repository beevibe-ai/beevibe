import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  SessionFooterFields,
  SessionIdentityHeader,
  SessionMetaItem,
} from "./session-chrome";

describe("SessionIdentityHeader", () => {
  it("renders the agent label, hierarchy chip and the caller's title", () => {
    render(
      <SessionIdentityHeader
        agentLabel="Scout"
        agentHierarchy="ic"
        status="succeeded"
        title="Conversation"
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Conversation");
    expect(screen.getByText("Scout")).toBeInTheDocument();
    expect(screen.getByText("ic")).toBeInTheDocument();
  });

  it("merges titleClassName onto the heading rather than replacing the base", () => {
    render(
      <SessionIdentityHeader
        agentLabel="Scout"
        agentHierarchy="ic"
        status="running"
        title="A very long intent"
        titleClassName="truncate"
      />,
    );
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveClass("truncate");
    expect(h1).toHaveClass("text-base", "font-semibold", "leading-tight");
  });

  it("renders caller-supplied meta items after the hierarchy chip", () => {
    render(
      <SessionIdentityHeader
        agentLabel="Scout"
        agentHierarchy="team"
        status="succeeded"
        title="Conversation"
        meta={<SessionMetaItem tabularNums>3 turns</SessionMetaItem>}
      />,
    );
    expect(screen.getByText("3 turns")).toHaveClass("tabular-nums");
  });
});

describe("SessionMetaItem", () => {
  it("prefixes its value with the separator both pages use", () => {
    render(<SessionMetaItem>chat</SessionMetaItem>);
    expect(screen.getByText("·")).toBeInTheDocument();
    expect(screen.getByText("chat")).toHaveClass("text-foreground/70");
  });
});

describe("SessionFooterFields", () => {
  it("labels the id field per the caller — session vs conversation", () => {
    render(<SessionFooterFields idLabel="Conversation ID" id="conv_1" type="chat" />);
    expect(screen.getByText("Conversation ID")).toBeInTheDocument();
  });

  it("renders CLI session and worktree when present", () => {
    render(
      <SessionFooterFields
        idLabel="Session ID"
        id="ses_1"
        cliSession="abc-123"
        worktree="/tmp/wt"
        type="task"
      />,
    );
    expect(screen.getByText("abc-123")).toBeInTheDocument();
    expect(screen.getByText("/tmp/wt")).toBeInTheDocument();
    expect(screen.getByText("task")).toBeInTheDocument();
  });

  it("omits CLI session and worktree when the session has neither", () => {
    // A pending session has no CLI session or worktree yet; the grid must not
    // render empty labelled cells for them.
    render(<SessionFooterFields idLabel="Session ID" id="ses_1" type="task" />);
    expect(screen.queryByText("CLI session")).not.toBeInTheDocument();
    expect(screen.queryByText("Worktree")).not.toBeInTheDocument();
    expect(screen.getByText("Session ID")).toBeInTheDocument();
  });
});
