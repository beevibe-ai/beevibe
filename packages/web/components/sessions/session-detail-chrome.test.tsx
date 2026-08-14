import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  SessionIdentityHeader,
  SessionMetaFooter,
} from "./session-detail-chrome";

describe("SessionIdentityHeader", () => {
  it("renders the title, agent label and hierarchy chip", () => {
    render(
      <SessionIdentityHeader
        agentLabel="Ada"
        agentHierarchy="ic"
        status="succeeded"
        title="One turn"
      />,
    );
    expect(screen.getByRole("heading", { name: "One turn" })).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("ic")).toBeInTheDocument();
  });

  it("dot-separates each meta item and drops the null ones", () => {
    // The separator belongs to the item, not to the row — a conditional
    // meta entry that renders `null` must not leave a stray "·" behind.
    const { container } = render(
      <SessionIdentityHeader
        agentLabel="Ada"
        agentHierarchy="team"
        status="running"
        title="Conversation"
        meta={[null, <span key="t">chat</span>]}
      />,
    );
    expect(screen.getByText("chat")).toBeInTheDocument();
    expect(container.querySelectorAll("span.text-muted-foreground\\/50")).toHaveLength(1);
  });
});

describe("SessionMetaFooter", () => {
  it("labels the id field per-page and always renders the type", () => {
    render(
      <SessionMetaFooter idLabel="Conversation ID" id="sess_abc123" type="chat" />,
    );
    expect(screen.getByText("Conversation ID")).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("chat")).toBeInTheDocument();
  });

  it("omits CLI session and worktree when the session never spawned a process", () => {
    render(<SessionMetaFooter idLabel="Session ID" id="sess_abc123" type="task" />);
    expect(screen.queryByText("CLI session")).not.toBeInTheDocument();
    expect(screen.queryByText("Worktree")).not.toBeInTheDocument();
  });

  it("renders CLI session and worktree when present", () => {
    render(
      <SessionMetaFooter
        idLabel="Session ID"
        id="sess_abc123"
        cliSession="cli-99"
        worktree="/tmp/wt"
        type="task"
      />,
    );
    expect(screen.getByText("cli-99")).toBeInTheDocument();
    expect(screen.getByText("/tmp/wt")).toBeInTheDocument();
  });
});
