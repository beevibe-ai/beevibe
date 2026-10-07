import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ChatStreamStep, ChatStreamTree } from "@/lib/chat-stream";

// Stubbed so the assertions below pin ToolStepList's own create_task ↔
// child-session pairing rather than the nested transcript's rendering.
vi.mock("./inline-ic-transcript", () => ({
  InlineICTranscript: ({ sessionId, depth }: { sessionId: string; depth: number }) => (
    <div data-testid="inline-ic" data-session-id={sessionId} data-depth={depth} />
  ),
}));

import { ToolStepList } from "./tool-step-list";

let seq = 0;
function step(overrides: Partial<ChatStreamStep> = {}): ChatStreamStep {
  return {
    event_id: `evt_${++seq}`,
    kind: "tool_call",
    tool_name: "Read",
    content: '{"file_path":"/src/auth.ts"}',
    received_at: 1000 + seq,
    ...overrides,
  };
}

/** A tree whose root spawned `childIds`, in order. */
function makeTree(rootId: string, childIds: string[]): ChatStreamTree {
  return { nodes: {}, children: { [rootId]: childIds }, steps: {} };
}

describe("ToolStepList", () => {
  it("renders one row per step with the tool's label and detail", () => {
    render(
      <ToolStepList
        steps={[
          step({ tool_name: "Read", content: '{"file_path":"/src/auth.ts"}' }),
          step({ tool_name: "Bash", content: '{"command":"pnpm test"}' }),
        ]}
        totalSteps={2}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText(/src\/auth\.ts/)).toBeInTheDocument();
  });

  it("strips the runtime's [error] prefix off a failed tool result", () => {
    render(
      <ToolStepList
        steps={[step({ kind: "tool_result", content: "[error] ENOENT: no such file" })]}
        totalSteps={1}
      />,
    );

    expect(screen.getByText("ENOENT: no such file")).toBeInTheDocument();
    expect(screen.queryByText(/\[error\]/)).not.toBeInTheDocument();
  });

  it("falls back to a placeholder when a result carries no text", () => {
    render(
      <ToolStepList
        steps={[
          step({ kind: "tool_result", content: "" }),
          step({ kind: "tool_result", content: "[error] " }),
        ]}
        totalSteps={2}
      />,
    );

    expect(screen.getByText("result")).toBeInTheDocument();
    expect(screen.getByText("tool error")).toBeInTheDocument();
  });

  it("rolls older steps into a pluralized 'earlier moves' line", () => {
    render(<ToolStepList steps={[step(), step()]} totalSteps={7} />);

    expect(screen.getByText(/\+ 5 earlier moves/)).toBeInTheDocument();
  });

  it("uses the singular when exactly one step was rolled up", () => {
    render(<ToolStepList steps={[step()]} totalSteps={2} />);

    expect(screen.getByText(/\+ 1 earlier move$/)).toBeInTheDocument();
  });

  it("omits the rollup line when every step is shown", () => {
    render(<ToolStepList steps={[step(), step()]} totalSteps={2} />);

    expect(screen.queryByText(/earlier move/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("renders the rich recall block for a session_search result with hits", () => {
    const payload = {
      kind: "discover",
      query: "auth middleware",
      hits: [
        {
          session: {
            session_id: "sess_abc123def456",
            conversation_id: null,
            type: "task",
            status: "completed",
            agent_id: "agent_alice",
            task_id: null,
            intent_preview: "Refactor auth middleware",
            created_at: new Date().toISOString(),
            completed_at: null,
            result_summary: null,
          },
          match_message_id: "evt_m",
          matched_role: "user",
          snippet: "the <b>auth</b> middleware",
          bookend_start: [],
          messages: [],
          bookend_end: [],
          messages_before: 0,
          messages_after: 0,
        },
      ],
    };
    const { container } = render(
      <ToolStepList
        steps={[
          step({ kind: "tool_result", tool_name: "session_search", content: JSON.stringify(payload) }),
        ]}
        totalSteps={1}
      />,
    );

    // the rich card's own header, which the lean one-line row has no equivalent of
    expect(screen.getByText("Past conversation")).toBeInTheDocument();
    // the query is echoed inside typographic quotes, so match on flattened text
    expect(container.textContent).toContain("auth middleware");
    // and not the raw JSON the lean row would have shown
    expect(screen.queryByText(/^\{"kind"/)).not.toBeInTheDocument();
  });

  it("falls back to the lean row when SSE truncation cut the recall JSON", () => {
    const truncated = '{"kind":"discover","query":"auth","hits":[{"session":{"session_i';
    render(
      <ToolStepList
        steps={[step({ kind: "tool_result", tool_name: "session_search", content: truncated })]}
        totalSteps={1}
      />,
    );

    expect(screen.getByText(truncated)).toBeInTheDocument();
  });

  it("falls back to the lean row when a discover result has no hits", () => {
    const empty = JSON.stringify({ kind: "discover", query: "auth", hits: [] });
    render(
      <ToolStepList
        steps={[step({ kind: "tool_result", tool_name: "session_search", content: empty })]}
        totalSteps={1}
      />,
    );

    expect(screen.getByText(empty)).toBeInTheDocument();
  });

  it("nests the Nth spawned session under the Nth create_task call", () => {
    render(
      <ToolStepList
        steps={[
          step({ tool_name: "create_task", content: '{"intent":"first"}' }),
          step({ tool_name: "Read" }),
          step({ tool_name: "create_task", content: '{"intent":"second"}' }),
        ]}
        totalSteps={3}
        tree={makeTree("sess_root", ["sess_child_a", "sess_child_b"])}
        parentSessionId="sess_root"
      />,
    );

    const nested = screen.getAllByTestId("inline-ic");
    expect(nested.map((n) => n.getAttribute("data-session-id"))).toEqual([
      "sess_child_a",
      "sess_child_b",
    ]);
  });

  it("leaves a create_task row unnested when no child session has spawned yet", () => {
    render(
      <ToolStepList
        steps={[step({ tool_name: "create_task" }), step({ tool_name: "create_task" })]}
        totalSteps={2}
        tree={makeTree("sess_root", ["sess_child_a"])}
        parentSessionId="sess_root"
      />,
    );

    // only the first create_task has a child to pair with
    expect(screen.getAllByTestId("inline-ic")).toHaveLength(1);
  });

  it("renders no nested transcript without a tree", () => {
    render(<ToolStepList steps={[step({ tool_name: "create_task" })]} totalSteps={1} />);

    expect(screen.queryByTestId("inline-ic")).not.toBeInTheDocument();
  });

  it("passes the incremented depth down to the nested transcript", () => {
    render(
      <ToolStepList
        steps={[step({ tool_name: "create_task" })]}
        totalSteps={1}
        tree={makeTree("sess_root", ["sess_child_a"])}
        parentSessionId="sess_root"
        depth={1}
      />,
    );

    expect(screen.getByTestId("inline-ic")).toHaveAttribute("data-depth", "2");
  });

  it("fades older rows toward a floor when the latest step is emphasized", () => {
    const { container } = render(
      <ToolStepList
        steps={[step(), step(), step(), step(), step()]}
        totalSteps={5}
        emphasizeLatest
      />,
    );

    const rows = Array.from(container.querySelectorAll("li"));
    // newest row is last in the list and stays fully opaque
    expect(rows.at(-1)!.style.opacity).toBe("1");
    // the oldest row sits on the 0.4 floor rather than going further down
    expect(rows[0]!.style.opacity).toBe("0.4");
  });

  it("applies no per-row opacity when emphasis is off", () => {
    const { container } = render(<ToolStepList steps={[step(), step()]} totalSteps={2} />);

    for (const row of container.querySelectorAll("li")) {
      expect(row.style.opacity).toBe("");
    }
  });

  it("adds a separating top border only when asked", () => {
    const { container: plain } = render(<ToolStepList steps={[step()]} totalSteps={1} />);
    expect(plain.querySelector("ul")!.className).not.toContain("border-t");

    const { container: bordered } = render(
      <ToolStepList steps={[step()]} totalSteps={1} withTopBorder />,
    );
    expect(bordered.querySelector("ul")!.className).toContain("border-t");
  });

  it("indents a tool_result under the call it answers", () => {
    const { container } = render(
      <ToolStepList
        steps={[
          step({ kind: "tool_call", tool_name: "Read" }),
          step({ kind: "tool_result", content: "42 lines" }),
        ]}
        totalSteps={2}
      />,
    );

    const rows = Array.from(container.querySelectorAll("li"));
    expect(rows[1]!.className).toContain("pl-3");
    expect(within(rows[1]!).getByText("42 lines")).toBeInTheDocument();
  });
});
