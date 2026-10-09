import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  MetaSeparator,
  SessionDetailFooter,
  SessionDetailHeader,
  SessionDetailSkeleton,
} from "./session-detail-chrome";

describe("SessionDetailHeader", () => {
  const base = {
    agentLabel: "Ada",
    hierarchy: "ic" as const,
    status: "running" as const,
    title: "do_the_thing: make it so",
  };

  it("renders the title as the h1 alongside the status pill", () => {
    render(<SessionDetailHeader {...base} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("do_the_thing: make it so");
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  /**
   * The task page's h1 was the only one in the app missing `tracking-tight`,
   * and the chat page's was the only session title without `truncate`.
   * Sharing the header settles both: `truncate` is what keeps a long
   * formatted intent from pushing the status pill off the row, and is inert
   * on the chat page's two-word literal.
   */
  it("carries both tracking-tight and truncate", () => {
    const { container } = render(<SessionDetailHeader {...base} />);
    expect(container.querySelector("h1")).toHaveClass("tracking-tight", "truncate");
  });

  it("always shows the agent label and hierarchy chip", () => {
    render(<SessionDetailHeader {...base} />);
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("ic")).toBeInTheDocument();
  });

  it("appends the page's own meta items after the chip", () => {
    render(
      <SessionDetailHeader
        {...base}
        meta={
          <>
            <MetaSeparator />
            <span>4m 12s</span>
          </>
        }
      />,
    );
    expect(screen.getByText("4m 12s")).toBeInTheDocument();
  });

  it("renders without meta — a page may have no extra items", () => {
    const { container } = render(<SessionDetailHeader {...base} />);
    expect(container.querySelectorAll("header")).toHaveLength(1);
    expect(container.textContent).not.toContain("·");
  });

  // Drives the avatar's live pip, so it has to key off status, not a flag
  // each page computes for itself.
  it("marks the avatar present only while running", () => {
    const { container: running } = render(<SessionDetailHeader {...base} />);
    expect(running.innerHTML).toContain("animate-pulse-breathe");

    const { container: done } = render(<SessionDetailHeader {...base} status="succeeded" />);
    expect(done.querySelector(".bg-status-running.animate-pulse-breathe")).toBeNull();
  });
});

describe("SessionDetailFooter", () => {
  const base = { idLabel: "Session ID", id: "ses_1111", type: "task" };

  it("labels the id field per page and always shows the type", () => {
    render(<SessionDetailFooter {...base} />);
    expect(screen.getByText("Session ID")).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("task")).toBeInTheDocument();
  });

  it("shows the CLI session and worktree when present", () => {
    render(<SessionDetailFooter {...base} cliSession="cli_abcdef" worktree="/w/t/99" />);
    expect(screen.getByText("cli_abcdef")).toBeInTheDocument();
    expect(screen.getByText("/w/t/99")).toBeInTheDocument();
  });

  // The common case for a session that never reached a daemon — the fields
  // are dropped rather than rendered empty.
  it("omits them when absent", () => {
    render(<SessionDetailFooter {...base} />);
    expect(screen.queryByText("CLI session")).not.toBeInTheDocument();
    expect(screen.queryByText("Worktree")).not.toBeInTheDocument();
  });

  it("omits them for null as well as undefined", () => {
    render(<SessionDetailFooter {...base} cliSession={null} worktree={null} />);
    expect(screen.queryByText("CLI session")).not.toBeInTheDocument();
    expect(screen.queryByText("Worktree")).not.toBeInTheDocument();
  });

  it("drops only the missing one of the pair", () => {
    render(<SessionDetailFooter {...base} cliSession="cli_abcdef" />);
    expect(screen.getByText("CLI session")).toBeInTheDocument();
    expect(screen.queryByText("Worktree")).not.toBeInTheDocument();
  });
});

describe("SessionDetailSkeleton", () => {
  it("renders the three placeholder bars both pages load behind", () => {
    const { container } = render(<SessionDetailSkeleton />);
    expect(container.children).toHaveLength(3);
  });
});
