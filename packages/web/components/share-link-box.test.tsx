import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

import { ShareLinkBox } from "./share-link-box";

const LINK = "https://beevibe.test/sign-up?email=alice%40example.com";

afterEach(() => {
  vi.restoreAllMocks();
});

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

describe("ShareLinkBox", () => {
  it("shows the hint and the link in a read-only field", () => {
    render(<ShareLinkBox hint="Send them this link:" link={LINK} />);
    expect(screen.getByText("Send them this link:")).toBeInTheDocument();
    const field = screen.getByDisplayValue(LINK);
    expect(field).toHaveAttribute("readonly");
  });

  it("accepts rich hint content, not just a string", () => {
    render(
      <ShareLinkBox
        hint={
          <>
            No account yet. <strong>Share this.</strong>
          </>
        }
        link={LINK}
      />,
    );
    expect(screen.getByText("Share this.")).toBeInTheDocument();
  });

  it("copies the link and flashes Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<ShareLinkBox hint="hint" link={LINK} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(LINK);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument(),
    );
  });

  it("stays on Copy when the clipboard write is rejected", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    render(<ShareLinkBox hint="hint" link={LINK} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("selects the whole link on focus so it stays copyable by hand", async () => {
    render(<ShareLinkBox hint="hint" link={LINK} />);
    const field = screen.getByDisplayValue(LINK) as HTMLInputElement;
    const select = vi.spyOn(field, "select");
    field.focus();
    expect(select).toHaveBeenCalled();
  });
});
