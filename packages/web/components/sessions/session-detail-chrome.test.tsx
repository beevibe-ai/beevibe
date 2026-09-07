import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionDetailFooter, SessionDetailHeader } from "./session-detail-chrome";

const base = {
  agentLabel: "Ada",
  agentHierarchy: "team" as const,
  status: "succeeded" as const,
  title: "Conversation",
};

describe("SessionDetailHeader", () => {
  it("renders the title, the agent, and no separator when there is no meta", () => {
    const { container } = render(<SessionDetailHeader {...base} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Conversation");
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(container.textContent).not.toContain("·");
  });

  it("puts a separator before each meta entry", () => {
    const { container } = render(
      <SessionDetailHeader
        {...base}
        meta={[<span key="a">2 turns</span>, <span key="b">chat</span>]}
      />,
    );
    const dots = [...container.querySelectorAll("span")].filter((s) => s.textContent === "·");
    expect(dots).toHaveLength(2);
  });

  it("drops a nullish meta entry along with its separator", () => {
    const { container } = render(
      <SessionDetailHeader {...base} meta={[null, <span key="b">chat</span>]} />,
    );
    const dots = [...container.querySelectorAll("span")].filter((s) => s.textContent === "·");
    expect(dots).toHaveLength(1);
    expect(container.textContent).toContain("chat");
  });

  it("applies the caller's title class on top of the shared one", () => {
    const { container } = render(<SessionDetailHeader {...base} titleClassName="truncate" />);
    const h1 = container.querySelector("h1");
    expect(h1?.className).toContain("truncate");
    expect(h1?.className).toContain("font-semibold");
  });
});

describe("SessionDetailFooter", () => {
  it("labels the id field per caller and shows the optional fields", () => {
    render(
      <SessionDetailFooter
        idLabel="Conversation ID"
        id="conv_1"
        cliSession="cli-abc"
        worktree="/tmp/wt"
        type="chat"
      />,
    );
    expect(screen.getByText("Conversation ID")).toBeTruthy();
    expect(screen.getByText("cli-abc")).toBeTruthy();
    expect(screen.getByText("/tmp/wt")).toBeTruthy();
  });

  it("hides CLI session and worktree when the runtime didn't report them", () => {
    render(<SessionDetailFooter idLabel="Session ID" id="sess_1" type="task" />);
    expect(screen.queryByText("CLI session")).toBeNull();
    expect(screen.queryByText("Worktree")).toBeNull();
    expect(screen.getByText("Type")).toBeTruthy();
  });
});
