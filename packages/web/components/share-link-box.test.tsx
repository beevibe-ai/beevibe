import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ShareLinkBox } from "./share-link-box";

const LINK = "https://beevibe.test/sign-up?email=alice%40example.com";

describe("ShareLinkBox", () => {
  it("renders the link read-only so it can't be edited into something else", () => {
    render(<ShareLinkBox blurb="Send them this link:" link={LINK} />);
    const field = screen.getByDisplayValue(LINK) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(screen.getByText("Send them this link:")).toBeTruthy();
  });

  it("copies the link and flashes the confirmation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(<ShareLinkBox blurb="Send them this link:" link={LINK} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("leaves the field selectable when the clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });

    render(<ShareLinkBox blurb="Send them this link:" link={LINK} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));

    // No clipboard write is possible, so the button must not claim success —
    // manual select-and-copy stays the fallback.
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
