import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { BvEvent } from "@/lib/sse";
import type { MemoryFactDisplay } from "@/lib/types/memory-facts";

// The host subscribes through useSseEvents; capture the callback so each
// case can drive the stream by hand instead of standing up an EventSource.
let emit: ((ev: BvEvent) => void) | undefined;
vi.mock("@/lib/sse", () => ({
  useSseEvents: (cb: (ev: BvEvent) => void) => {
    emit = cb;
  },
}));

const listFacts = vi.fn<() => Promise<MemoryFactDisplay[]>>();
vi.mock("@/lib/api/client", () => ({
  // the host passes a filter + an AbortSignal; neither steers these cases
  api: { memory: { listFacts: () => listFacts() } },
}));

import { MemoryToastHost } from "./memory-toast-host";

function makeFact(overrides: Partial<MemoryFactDisplay> = {}): MemoryFactDisplay {
  return {
    id: "fact_1",
    content: "Prefer pnpm over npm in this repo",
    fact_type: "preference",
    scope: "team",
    agent_id: "agent_alice",
    agent_label: "Alice",
    source_session_count: 1,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as MemoryFactDisplay;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Push a fact event through the stream and let the fetchQuery promise settle. */
async function fire(id: string) {
  await act(async () => {
    emit!({ event: "memory.fact.created", id } as BvEvent);
  });
}

describe("MemoryToastHost", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    emit = undefined;
    listFacts.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing until a fact arrives", () => {
    const { container } = render(<MemoryToastHost />, { wrapper });

    expect(container).toBeEmptyDOMElement();
  });

  it("announces a learned fact with its type, scope, agent and content", async () => {
    listFacts.mockResolvedValue([makeFact({ id: "fact_1" })]);
    render(<MemoryToastHost />, { wrapper });

    await fire("fact_1");

    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Preference")).toBeInTheDocument();
    expect(screen.getByText("team")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Prefer pnpm over npm in this repo")).toBeInTheDocument();
    // the whole toast is a link to the memory page
    expect(screen.getByRole("link")).toHaveAttribute("href", "/memory");
  });

  it("ignores stream events that are not fact creations", async () => {
    listFacts.mockResolvedValue([makeFact()]);
    const { container } = render(<MemoryToastHost />, { wrapper });

    await act(async () => {
      emit!({ event: "session.step", id: "evt_1" } as BvEvent);
    });

    expect(listFacts).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("stays silent when the fact is not visible to this user", async () => {
    listFacts.mockResolvedValue([makeFact({ id: "fact_other" })]);
    const { container } = render(<MemoryToastHost />, { wrapper });

    await fire("fact_1");

    expect(listFacts).toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();

    // and the subscription survives the skip — a later visible fact still toasts
    listFacts.mockResolvedValue([makeFact({ id: "fact_2", content: "visible fact" })]);
    await fire("fact_2");
    expect(screen.getByText("visible fact")).toBeInTheDocument();
  });

  it("stays silent when the metadata lookup fails", async () => {
    listFacts.mockRejectedValue(new Error("offline"));
    const { container } = render(<MemoryToastHost />, { wrapper });

    await fire("fact_1");

    expect(container).toBeEmptyDOMElement();
  });

  it("flattens mono segments out of rich-text content", async () => {
    listFacts.mockResolvedValue([
      makeFact({ content: ["Run ", { mono: "pnpm dev" }, " to start the stack"] }),
    ]);
    render(<MemoryToastHost />, { wrapper });

    await fire("fact_1");

    expect(screen.getByText("Run pnpm dev to start the stack")).toBeInTheDocument();
  });

  it("truncates a long fact to a single-line preview", async () => {
    const long = "x".repeat(200);
    listFacts.mockResolvedValue([makeFact({ content: long })]);
    render(<MemoryToastHost />, { wrapper });

    await fire("fact_1");

    const preview = screen.getByText(/x+…$/);
    // 90-char cap: 89 chars + the ellipsis
    expect(preview.textContent).toHaveLength(90);
  });

  it("collapses whitespace when building the preview", async () => {
    listFacts.mockResolvedValue([makeFact({ content: "  spans\n\n  several   lines  " })]);
    render(<MemoryToastHost />, { wrapper });

    await fire("fact_1");

    expect(screen.getByText("spans several lines")).toBeInTheDocument();
  });

  it("falls back to the raw fact_type when it has no friendly label", async () => {
    listFacts.mockResolvedValue([makeFact({ fact_type: "hunch" as never })]);
    render(<MemoryToastHost />, { wrapper });

    await fire("fact_1");

    expect(screen.getByText("hunch")).toBeInTheDocument();
  });

  it("aggregates facts arriving inside the window into one toast", async () => {
    listFacts.mockResolvedValue([
      makeFact({ id: "fact_1", content: "first fact" }),
      makeFact({ id: "fact_2", content: "second fact" }),
    ]);
    render(<MemoryToastHost />, { wrapper });

    await fire("fact_1");
    await fire("fact_2");

    // one toast, newest fact on top, older rolled into the tail
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText(/second fact/)).toBeInTheDocument();
    expect(screen.getByText("(+1 more)")).toBeInTheDocument();
  });

  it("starts a separate toast once the aggregation window has passed", async () => {
    listFacts.mockResolvedValue([
      makeFact({ id: "fact_1", content: "first fact" }),
      makeFact({ id: "fact_2", content: "second fact" }),
    ]);
    render(<MemoryToastHost />, { wrapper });

    await fire("fact_1");
    await act(async () => {
      vi.advanceTimersByTime(3100); // past AGGREGATE_WINDOW_MS, before auto-dismiss
    });
    await fire("fact_2");

    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.queryByText(/\(\+\d+ more\)/)).not.toBeInTheDocument();
  });

  it("keeps aggregating as long as facts keep arriving inside the window", async () => {
    listFacts.mockResolvedValue([
      makeFact({ id: "fact_1", content: "first fact" }),
      makeFact({ id: "fact_2", content: "second fact" }),
      makeFact({ id: "fact_3", content: "third fact" }),
    ]);
    render(<MemoryToastHost />, { wrapper });

    // each gap is inside AGGREGATE_WINDOW_MS, but the total span is not —
    // aggregating refreshes createdAt, so the chain keeps extending.
    await fire("fact_1");
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    await fire("fact_2");
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    await fire("fact_3");

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText(/third fact/)).toBeInTheDocument();
    expect(screen.getByText("(+2 more)")).toBeInTheDocument();
  });

  it("auto-dismisses a toast after its lifetime", async () => {
    listFacts.mockResolvedValue([makeFact({ id: "fact_1" })]);
    render(<MemoryToastHost />, { wrapper });

    await fire("fact_1");
    expect(screen.getByRole("status")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(5600); // past AUTO_DISMISS_MS
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("restarts the dismiss timer when another fact aggregates in", async () => {
    listFacts.mockResolvedValue([
      makeFact({ id: "fact_1", content: "first fact" }),
      makeFact({ id: "fact_2", content: "second fact" }),
    ]);
    render(<MemoryToastHost />, { wrapper });

    await fire("fact_1");
    await act(async () => {
      vi.advanceTimersByTime(2500); // inside the aggregation window
    });
    await fire("fact_2");

    // 3.5s after the first fact — it would already be gone on the original timer
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2500); // now past the restarted timer
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("caps how many toasts stack up at once", async () => {
    listFacts.mockResolvedValue([
      makeFact({ id: "fact_1" }),
      makeFact({ id: "fact_2" }),
      makeFact({ id: "fact_3" }),
      makeFact({ id: "fact_4" }),
      makeFact({ id: "fact_5" }),
    ]);
    render(<MemoryToastHost />, { wrapper });

    // space each one past the aggregation window so every fact mints its own toast
    for (const id of ["fact_1", "fact_2", "fact_3", "fact_4", "fact_5"]) {
      await fire(id);
      await act(async () => {
        vi.advanceTimersByTime(3100);
      });
    }

    // MAX_VISIBLE is 4
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });

  it("dismisses on the X without navigating to the memory page", async () => {
    listFacts.mockResolvedValue([makeFact({ id: "fact_1" })]);
    render(<MemoryToastHost />, { wrapper });
    await fire("fact_1");

    // React delegates at the root, so inspect the event after dispatch
    // rather than from a listener on the button itself.
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).dispatchEvent(click);
    });

    // preventDefault keeps the surrounding <Link> from navigating to /memory
    expect(click.defaultPrevented).toBe(true);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
