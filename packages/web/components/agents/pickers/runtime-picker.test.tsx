/**
 * Binding an agent to a runtime is the setting that decides whether it
 * can run at all — unbound, its task and chat sessions sit pending.
 * So the branches worth pinning are the ones that change what the user
 * is told about that:
 *
 *   - no daemons registered at all → a link to /runtimes, not a picker
 *     that opens onto nothing
 *   - bound-but-offline vs. bound-and-online vs. unbound, which the chip
 *     encodes in the dot tone and the label
 *   - "Unbind" posting `null` rather than the empty string
 *
 * Daemons with no `device_name` fall back to `external_id` for their
 * group heading; without that, a freshly-registered daemon groups its
 * runtimes under a blank header.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { DaemonPanelEntry, RuntimesListResponse } from "@/lib/api/client";
import type { AgentDisplay } from "@/lib/api/types";

vi.mock("@/lib/api/client", () => ({
  api: { agents: { setRuntime: vi.fn() }, runtimes: { list: vi.fn() } },
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { api } from "@/lib/api/client";
import { RuntimeChip, RuntimePicker } from "./runtime-picker";

const setRuntime = vi.mocked(api.agents.setRuntime);
const listRuntimes = vi.mocked(api.runtimes.list);

function agentWith(preferred_runtime_id?: string): AgentDisplay {
  return {
    id: "agt_1",
    name: "backend",
    display_name: "Backend",
    hierarchy: "ic",
    hierarchy_level: "ic",
    owner_id: "u_1",
    created_at: new Date(),
    updated_at: new Date(),
    ...(preferred_runtime_id === undefined ? {} : { preferred_runtime_id }),
  };
}

function daemon(over: Partial<DaemonPanelEntry> = {}): DaemonPanelEntry {
  return {
    id: "dmn_1",
    device_name: "alice-mbp",
    external_id: "ext_1",
    created_at: new Date().toISOString(),
    runtimes: [
      { id: "rt_online", cli: "claude", cli_version: "2.0.1", online: true },
    ],
    ...over,
  };
}

function listResponse(daemons: DaemonPanelEntry[]): RuntimesListResponse {
  return { ok: true, daemons };
}

/**
 * Every branch in these components reads `runtimesQuery.data`, so each
 * case reaches for the settled state with `findBy*` rather than
 * asserting synchronously against the loading render.
 */
function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  setRuntime.mockReset();
  setRuntime.mockResolvedValue({ ok: true } as never);
  listRuntimes.mockReset();
  listRuntimes.mockResolvedValue(listResponse([daemon()]));
});

describe("RuntimeChip", () => {
  it("renders a Set-up-a-daemon link when no daemons are registered", async () => {
    listRuntimes.mockResolvedValue(listResponse([]));
    renderWithClient(<RuntimeChip agent={agentWith(undefined)} />);

    const link = await screen.findByRole("link", { name: /Set up a daemon/ });
    expect(link).toHaveAttribute("href", "/runtimes");
    // No popover trigger at all — there'd be nothing behind it.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders the daemon's runtimes with cli + version once loaded", async () => {
    renderWithClient(<RuntimeChip agent={agentWith("rt_online")} />);

    expect(
      await screen.findByRole("button", { name: /Runtime: claude 2.0.1/ }),
    ).toHaveTextContent("claude 2.0.1");
  });

  it("drops the version suffix when the runtime reports none", async () => {
    listRuntimes.mockResolvedValue(
      listResponse([
        daemon({ runtimes: [{ id: "rt_online", cli: "codex", online: true }] }),
      ]),
    );
    renderWithClient(<RuntimeChip agent={agentWith("rt_online")} />);

    expect(
      await screen.findByRole("button", { name: /Runtime: codex\./ }),
    ).toHaveTextContent("codex");
  });

  it("shows the unbound CTA in amber when the agent has no runtime", async () => {
    renderWithClient(<RuntimeChip agent={agentWith(undefined)} />);

    const chip = await screen.findByRole("button", { name: /Runtime: unbound/ });
    expect(chip).toHaveTextContent("Set runtime");
    expect(chip.className).toContain("amber");
  });

  it("treats a runtime id that matches nothing as unbound", async () => {
    // A revoked runtime leaves the agent pointing at an id the list no
    // longer carries; that has to read as unbound, not as bound-offline.
    renderWithClient(<RuntimeChip agent={agentWith("rt_deleted")} />);

    expect(
      await screen.findByRole("button", { name: /Runtime: unbound/ }),
    ).toBeInTheDocument();
  });

  it("mutes the chip when bound to an offline runtime", async () => {
    listRuntimes.mockResolvedValue(
      listResponse([
        daemon({
          runtimes: [
            { id: "rt_off", cli: "claude", cli_version: "2.0.1", online: false },
          ],
        }),
      ]),
    );
    renderWithClient(<RuntimeChip agent={agentWith("rt_off")} />);

    const chip = await screen.findByRole("button", { name: /Runtime: claude/ });
    expect(chip.className).toContain("text-muted-foreground");
  });

  it("groups runtimes under the device name, falling back to external_id", async () => {
    const user = userEvent.setup();
    listRuntimes.mockResolvedValue(
      listResponse([
        daemon({ id: "dmn_1", device_name: "alice-mbp" }),
        daemon({
          id: "dmn_2",
          device_name: undefined,
          external_id: "ext_unnamed",
          runtimes: [{ id: "rt_other", cli: "codex", online: false }],
        }),
      ]),
    );
    renderWithClient(<RuntimeChip agent={agentWith("rt_online")} />);

    await user.click(await screen.findByRole("button", { name: /Runtime:/ }));

    expect(screen.getByText("alice-mbp")).toBeInTheDocument();
    expect(screen.getByText("ext_unnamed")).toBeInTheDocument();
  });

  it("labels offline rows and posts the chosen runtime id", async () => {
    const user = userEvent.setup();
    listRuntimes.mockResolvedValue(
      listResponse([
        daemon({
          runtimes: [
            { id: "rt_online", cli: "claude", cli_version: "2.0.1", online: true },
            { id: "rt_off", cli: "codex", online: false },
          ],
        }),
      ]),
    );
    renderWithClient(<RuntimeChip agent={agentWith("rt_online")} />);

    await user.click(await screen.findByRole("button", { name: /Runtime:/ }));

    expect(screen.getByRole("menuitem", { name: /codex/ })).toHaveTextContent("offline");
    expect(screen.getByRole("menuitem", { name: /claude 2.0.1/ })).not.toHaveTextContent(
      "offline",
    );

    await user.click(screen.getByRole("menuitem", { name: /codex/ }));
    expect(setRuntime).toHaveBeenCalledWith("agt_1", "rt_off");
  });

  it("posts null — not an empty string — when unbinding", async () => {
    const user = userEvent.setup();
    renderWithClient(<RuntimeChip agent={agentWith("rt_online")} />);

    await user.click(await screen.findByRole("button", { name: /Runtime:/ }));
    await user.click(screen.getByRole("menuitem", { name: /Unbind/ }));

    expect(setRuntime).toHaveBeenCalledWith("agt_1", null);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("RuntimePicker", () => {
  it("shows a loading line before the runtimes arrive", () => {
    listRuntimes.mockReturnValue(new Promise(() => {}) as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RuntimePicker agent={agentWith(undefined)} />
      </QueryClientProvider>,
    );

    expect(screen.getByText(/Loading runtimes/)).toBeInTheDocument();
  });

  it("explains the empty state with a link instead of an empty select", async () => {
    listRuntimes.mockResolvedValue(listResponse([]));
    renderWithClient(<RuntimePicker agent={agentWith(undefined)} />);

    expect(await screen.findByText(/No daemons registered yet/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("selects the bound runtime and labels options by device and status", async () => {
    listRuntimes.mockResolvedValue(
      listResponse([
        daemon({
          runtimes: [
            { id: "rt_online", cli: "claude", cli_version: "2.0.1", online: true },
            { id: "rt_off", cli: "codex", online: false },
          ],
        }),
      ]),
    );
    renderWithClient(<RuntimePicker agent={agentWith("rt_online")} />);

    const select = await screen.findByRole("combobox");
    expect(select).toHaveValue("rt_online");
    expect(
      screen.getByRole("option", { name: "alice-mbp · claude 2.0.1 (online)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "alice-mbp · codex (offline)" }),
    ).toBeInTheDocument();
  });

  it("maps the unbound option back to null on change", async () => {
    const user = userEvent.setup();
    renderWithClient(<RuntimePicker agent={agentWith("rt_online")} />);

    await user.selectOptions(await screen.findByRole("combobox"), "");

    expect(setRuntime).toHaveBeenCalledWith("agt_1", null);
  });

  it("posts the selected runtime id", async () => {
    const user = userEvent.setup();
    renderWithClient(<RuntimePicker agent={agentWith(undefined)} />);

    await user.selectOptions(await screen.findByRole("combobox"), "rt_online");

    expect(setRuntime).toHaveBeenCalledWith("agt_1", "rt_online");
  });

  it("surfaces a failed update", async () => {
    const user = userEvent.setup();
    setRuntime.mockRejectedValue(new Error("boom"));
    renderWithClient(<RuntimePicker agent={agentWith(undefined)} />);

    await user.selectOptions(await screen.findByRole("combobox"), "rt_online");

    expect(await screen.findByText(/Couldn't update runtime/)).toBeInTheDocument();
  });
});
