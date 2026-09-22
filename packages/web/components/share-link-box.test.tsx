import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShareLinkBox } from "./share-link-box";

const LINK = "https://beevibe.test/sign-up?email=alice%40example.com";

function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
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
  it("shows the link read-only alongside the caller's prose", () => {
    render(<ShareLinkBox link={LINK}>Send them this link:</ShareLinkBox>);

    const input = screen.getByDisplayValue(LINK) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(screen.getByText("Send them this link:")).toBeTruthy();
  });

  it("copies the link it is displaying, then flashes Copied", async () => {
    // After `setup()`, which installs a clipboard stub of its own — this
    // test asserts on what the component writes, not on user-event's.
    const user = userEvent.setup();
    const writeText = stubClipboard();

    render(<ShareLinkBox link={LINK}>Send them this link:</ShareLinkBox>);
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith(LINK);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
  });

  it("selects the whole URL on focus so a manual copy gets all of it", () => {
    render(<ShareLinkBox link={LINK}>Send them this link:</ShareLinkBox>);

    const input = screen.getByDisplayValue(LINK) as HTMLInputElement;
    const select = vi.spyOn(input, "select");
    input.focus();

    expect(select).toHaveBeenCalled();
  });
});
