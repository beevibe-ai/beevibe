import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ShareLinkBox } from "./share-link-box";

const LINK = "https://beevibe.test/sign-up?email=alice%40example.com";

function stubClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("ShareLinkBox", () => {
  it("shows the link and the caller's hint", () => {
    render(<ShareLinkBox link={LINK} hint="Send them this link:" />);
    expect(screen.getByDisplayValue(LINK)).toBeTruthy();
    expect(screen.getByText("Send them this link:")).toBeTruthy();
  });

  it("keeps the link read-only but selectable, so a failed copy isn't a dead end", () => {
    render(<ShareLinkBox link={LINK} hint="hint" />);
    const input = screen.getByDisplayValue(LINK) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(false);
  });

  it("copies the link and flashes Copied", async () => {
    const writeText = stubClipboard();
    render(<ShareLinkBox link={LINK} hint="hint" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
  });

  it("selects the whole link on focus", () => {
    render(<ShareLinkBox link={LINK} hint="hint" />);
    const input = screen.getByDisplayValue(LINK) as HTMLInputElement;
    fireEvent.focus(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(LINK.length);
  });
});
