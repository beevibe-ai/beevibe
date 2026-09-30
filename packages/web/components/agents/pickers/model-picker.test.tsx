/**
 * The model picker carries one sentinel that has to survive the round
 * trip in both directions: the empty string means "CLI default", and
 * the wire value for it is `null` (which clears `runtime_config.model`
 * server-side). Posting `""` instead would pin the agent to a model
 * named empty-string; rendering `null` as anything but "CLI default"
 * would tell the user they've pinned something they haven't.
 *
 * The card variant adds a custom-model text path plus an effect that
 * re-syncs local state when `agent.model` changes underneath it — that
 * effect is what keeps the input from showing a stale pinned id after
 * someone changes the model from the chip in another view.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { AgentDisplay } from "@/lib/api/types";

vi.mock("@/lib/api/client", () => ({
  api: { agents: { setModel: vi.fn() } },
}));

import { api } from "@/lib/api/client";
import { MODEL_PRESETS, ModelChip, ModelPicker } from "./model-picker";

const setModel = vi.mocked(api.agents.setModel);

function agentWith(model?: string): AgentDisplay {
  return {
    id: "agt_1",
    name: "backend",
    display_name: "Backend",
    hierarchy: "ic",
    hierarchy_level: "ic",
    owner_id: "u_1",
    created_at: new Date(),
    updated_at: new Date(),
    ...(model === undefined ? {} : { model }),
  };
}

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  setModel.mockReset();
  setModel.mockResolvedValue({ ok: true } as never);
});

describe("MODEL_PRESETS", () => {
  it("leads with the empty-string CLI-default sentinel", () => {
    expect(MODEL_PRESETS[0]).toMatchObject({ value: "", label: "CLI default" });
  });
});

describe("ModelChip", () => {
  it("labels an unset model as CLI default and styles it as the default", () => {
    renderWithClient(<ModelChip agent={agentWith(undefined)} />);
    const chip = screen.getByRole("button", { name: /Model: CLI default/ });
    expect(chip).toHaveTextContent("CLI default");
    expect(chip.className).toContain("italic");
  });

  it("labels a pinned preset with the preset's own label", () => {
    renderWithClient(<ModelChip agent={agentWith("opus")} />);
    const chip = screen.getByRole("button", { name: /Model: opus/ });
    expect(chip).toHaveTextContent("opus");
    expect(chip.className).not.toContain("italic");
  });

  it("falls back to the raw id for a custom pinned model", () => {
    renderWithClient(<ModelChip agent={agentWith("claude-opus-4-7")} />);
    expect(
      screen.getByRole("button", { name: /Model: claude-opus-4-7/ }),
    ).toHaveTextContent("claude-opus-4-7");
  });

  it("posts null — not the empty string — when picking CLI default", async () => {
    const user = userEvent.setup();
    renderWithClient(<ModelChip agent={agentWith("opus")} />);

    await user.click(screen.getByRole("button", { name: /Model:/ }));
    await user.click(screen.getByRole("menuitem", { name: /CLI default/ }));

    expect(setModel).toHaveBeenCalledWith("agt_1", null);
  });

  it("posts the alias when picking a named preset, and closes", async () => {
    const user = userEvent.setup();
    renderWithClient(<ModelChip agent={agentWith(undefined)} />);

    await user.click(screen.getByRole("button", { name: /Model:/ }));
    await user.click(screen.getByRole("menuitem", { name: /sonnet/ }));

    expect(setModel).toHaveBeenCalledWith("agt_1", "sonnet");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers one row per preset and no pinned row for a preset model", async () => {
    const user = userEvent.setup();
    renderWithClient(<ModelChip agent={agentWith("haiku")} />);

    await user.click(screen.getByRole("button", { name: /Model:/ }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(MODEL_PRESETS.length);
  });

  it("adds a read-only pinned row for a custom model, which only closes", async () => {
    const user = userEvent.setup();
    renderWithClient(<ModelChip agent={agentWith("claude-opus-4-7")} />);

    await user.click(screen.getByRole("button", { name: /Model:/ }));
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(MODEL_PRESETS.length + 1);

    const pinned = screen.getByRole("menuitem", { name: /claude-opus-4-7/ });
    expect(pinned).toHaveTextContent("pinned");

    // The pinned row is a no-op dismiss — re-posting the value it
    // already has would be a pointless write.
    await user.click(pinned);
    expect(setModel).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("points users at the detail page for pinning a custom id", async () => {
    const user = userEvent.setup();
    renderWithClient(<ModelChip agent={agentWith(undefined)} />);

    await user.click(screen.getByRole("button", { name: /Model:/ }));
    expect(screen.getByText(/Pin a custom model ID/)).toBeInTheDocument();
  });
});

describe("ModelPicker", () => {
  it("selects the current preset", () => {
    renderWithClient(<ModelPicker agent={agentWith("sonnet")} />);
    expect(screen.getByRole("combobox")).toHaveValue("sonnet");
  });

  it("selects the CLI-default option when the model is unset", () => {
    renderWithClient(<ModelPicker agent={agentWith(undefined)} />);
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("opens straight into custom mode for a non-preset model", () => {
    renderWithClient(<ModelPicker agent={agentWith("claude-opus-4-7")} />);
    expect(screen.getByRole("combobox")).toHaveValue("__custom");
    expect(screen.getByRole("textbox")).toHaveValue("claude-opus-4-7");
  });

  it("posts null when selecting CLI default", async () => {
    const user = userEvent.setup();
    renderWithClient(<ModelPicker agent={agentWith("opus")} />);

    await user.selectOptions(screen.getByRole("combobox"), "");

    expect(setModel).toHaveBeenCalledWith("agt_1", null);
  });

  it("posts the alias when selecting a preset", async () => {
    const user = userEvent.setup();
    renderWithClient(<ModelPicker agent={agentWith(undefined)} />);

    await user.selectOptions(screen.getByRole("combobox"), "haiku");

    expect(setModel).toHaveBeenCalledWith("agt_1", "haiku");
  });

  it("reveals the custom input without posting anything yet", async () => {
    const user = userEvent.setup();
    renderWithClient(<ModelPicker agent={agentWith(undefined)} />);

    await user.selectOptions(screen.getByRole("combobox"), "__custom");

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    // Selecting "Other…" is not itself a change — the value arrives on
    // submit, not on reveal.
    expect(setModel).not.toHaveBeenCalled();
  });

  it("posts the trimmed custom id on submit", async () => {
    const user = userEvent.setup();
    renderWithClient(<ModelPicker agent={agentWith(undefined)} />);

    await user.selectOptions(screen.getByRole("combobox"), "__custom");
    await user.type(screen.getByRole("textbox"), "  claude-opus-4-7  ");
    await user.click(screen.getByRole("button", { name: "Set" }));

    expect(setModel).toHaveBeenCalledWith("agt_1", "claude-opus-4-7");
  });

  it("keeps Set disabled while the custom id is blank or whitespace", async () => {
    const user = userEvent.setup();
    renderWithClient(<ModelPicker agent={agentWith(undefined)} />);

    await user.selectOptions(screen.getByRole("combobox"), "__custom");
    const set = screen.getByRole("button", { name: "Set" });
    expect(set).toBeDisabled();

    await user.type(screen.getByRole("textbox"), "   ");
    expect(set).toBeDisabled();

    await user.type(screen.getByRole("textbox"), "x");
    expect(set).toBeEnabled();
  });

  it("re-syncs when the agent's model changes underneath it", () => {
    const { rerender } = renderWithClient(
      <ModelPicker agent={agentWith("claude-opus-4-7")} />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("claude-opus-4-7");

    // Changed from elsewhere (the chip in the list view) to a preset:
    // custom mode has to drop, or the stale pinned id stays on screen.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={client}>
        <ModelPicker agent={agentWith("opus")} />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("combobox")).toHaveValue("opus");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("surfaces a failed update", async () => {
    const user = userEvent.setup();
    setModel.mockRejectedValue(new Error("boom"));
    renderWithClient(<ModelPicker agent={agentWith(undefined)} />);

    await user.selectOptions(screen.getByRole("combobox"), "opus");

    expect(await screen.findByText(/Couldn't update model/)).toBeInTheDocument();
  });
});
