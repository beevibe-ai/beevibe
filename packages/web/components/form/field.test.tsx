import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InlineError, ShareLinkBox, TextField, TextInput } from "./field";

describe("TextField", () => {
  it("associates the label with the input via id", () => {
    render(<TextField id="email" label="Email" type="email" />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
  });

  it("merges caller classes onto the shared input styling instead of replacing it", () => {
    // The key field adds `font-mono`; it must not lose the border/padding
    // that every other field in the app has.
    render(<TextField id="key" label="User API key" className="font-mono" />);
    const input = screen.getByLabelText("User API key");
    expect(input.className).toContain("font-mono");
    expect(input.className).toContain("border-border");
  });

  it("forwards arbitrary input props", () => {
    render(<TextField id="pw" label="Password" minLength={8} disabled />);
    const input = screen.getByLabelText("Password");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("minlength", "8");
  });
});

describe("TextInput", () => {
  it("renders an unlabeled input carrying the shared styling", () => {
    render(<TextInput placeholder="alice@example.com" />);
    const input = screen.getByPlaceholderText("alice@example.com");
    expect(input.className).toContain("border-border");
  });
});

describe("InlineError", () => {
  it("renders nothing when there is no message", () => {
    // Callers rely on this to drop their `{error ? … : null}` wrapper —
    // null, undefined and "" all have to collapse to nothing.
    const { container: a } = render(<InlineError message={null} />);
    expect(a).toBeEmptyDOMElement();
    const { container: b } = render(<InlineError message="" />);
    expect(b).toBeEmptyDOMElement();
  });

  it("renders the message and honours caller spacing", () => {
    const { container } = render(<InlineError message="Nope" className="mt-3" />);
    expect(screen.getByText("Nope")).toBeInTheDocument();
    expect(container.firstElementChild?.className).toContain("mt-3");
  });
});

describe("ShareLinkBox", () => {
  // `navigator.clipboard` is getter-only under happy-dom, so it has to be
  // redefined rather than assigned — same shape as the hook's own test.
  afterEach(() => Reflect.deleteProperty(navigator, "clipboard"));

  it("shows the link read-only and copies it on click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<ShareLinkBox hint="Send them this link:" link="https://x.test/sign-up" />);
    const field = screen.getByDisplayValue("https://x.test/sign-up");
    expect(field).toHaveAttribute("readonly");

    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("https://x.test/sign-up");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});
