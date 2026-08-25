import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ShareLinkBox } from "./share-link-box";

const writeText = vi.fn().mockResolvedValue(undefined);

// `navigator.clipboard` is a getter-only property in jsdom, so it has to be
// redefined rather than assigned.
beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("ShareLinkBox", () => {
  it("shows the url read-only next to its blurb", () => {
    render(<ShareLinkBox url="https://beevibe.test/sign-up">Send them this link:</ShareLinkBox>);
    expect(screen.getByText("Send them this link:")).toBeInTheDocument();
    const input = screen.getByDisplayValue("https://beevibe.test/sign-up");
    expect(input).toHaveAttribute("readonly");
  });

  it("copies the url and flips the button label", async () => {
    render(<ShareLinkBox url="https://beevibe.test/sign-up">blurb</ShareLinkBox>);
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("https://beevibe.test/sign-up");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("keeps each box's copied state to itself", async () => {
    render(
      <>
        <ShareLinkBox url="https://beevibe.test/one">one</ShareLinkBox>
        <ShareLinkBox url="https://beevibe.test/two">two</ShareLinkBox>
      </>,
    );
    const [first] = screen.getAllByRole("button", { name: "Copy" });
    await userEvent.click(first!);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    // The second box is untouched — one "Copy" left standing.
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(1);
  });
});
