import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KeyRound, LogIn } from "lucide-react";
import { AuthCard, AuthError, AuthField, AuthSubmitButton } from "./auth-form";

describe("AuthCard", () => {
  it("renders title, blurb, fields and footer, and submits the form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());

    render(
      <AuthCard
        icon={LogIn}
        title="Sign in to beevibe"
        blurb={<>Email + password.</>}
        onSubmit={onSubmit}
        footer={<>New here?</>}
      >
        <AuthSubmitButton icon={LogIn} label="Sign in" pendingLabel="Signing in…" pending={false} />
      </AuthCard>,
    );

    expect(screen.getByRole("heading", { name: "Sign in to beevibe" })).toBeTruthy();
    expect(screen.getByText("Email + password.")).toBeTruthy();
    expect(screen.getByText("New here?")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("AuthField", () => {
  it("wires the label to the input and reports raw values to onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <AuthField first id="email" label="Email" type="email" value="" onChange={onChange} />,
    );

    const input = screen.getByLabelText("Email");
    await user.type(input, "hi");
    // Controlled with a fixed "" value, so each keystroke reports one char.
    expect(onChange).toHaveBeenCalledWith("h");
  });

  it("passes native input attributes through", () => {
    render(
      <AuthField
        id="password"
        label="Password"
        type="password"
        minLength={8}
        autoComplete="new-password"
        value="secret"
        onChange={() => {}}
        disabled
      />,
    );

    const input = screen.getByLabelText("Password") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.minLength).toBe(8);
    expect(input.autocomplete).toBe("new-password");
    expect(input.disabled).toBe(true);
  });

  it("appends caller classes to the shared input styling rather than replacing it", () => {
    // The key-paste field wants `font-mono` and still the shared border,
    // padding and focus ring.
    render(
      <AuthField
        first
        id="key"
        label="User API key"
        className="font-mono"
        value=""
        onChange={() => {}}
      />,
    );

    const input = screen.getByLabelText("User API key");
    expect(input.className).toContain("font-mono");
    expect(input.className).toContain("focus:ring-ring");
  });

  it("drops the top margin only on the first field of a stack", () => {
    const { rerender } = render(
      <AuthField first id="a" label="First" value="" onChange={() => {}} />,
    );
    expect(document.querySelector("label")?.className).not.toContain("mt-3");

    rerender(<AuthField id="a" label="First" value="" onChange={() => {}} />);
    expect(document.querySelector("label")?.className).toContain("mt-3");
  });
});

describe("AuthError", () => {
  it("renders nothing without a message", () => {
    const { container } = render(<AuthError message={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the message when there is one", () => {
    render(<AuthError message="Email or password is incorrect." />);
    expect(screen.getByText("Email or password is incorrect.")).toBeTruthy();
  });
});

describe("AuthSubmitButton", () => {
  it("swaps to the pending label and disables itself while pending", () => {
    render(
      <AuthSubmitButton
        icon={KeyRound}
        label="Sign in"
        pendingLabel="Verifying…"
        pending
      />,
    );

    const button = screen.getByRole("button", { name: "Verifying…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("disables on the caller's own condition while idle", () => {
    render(
      <AuthSubmitButton
        icon={LogIn}
        label="Sign in"
        pendingLabel="Signing in…"
        pending={false}
        disabled
      />,
    );

    const button = screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("is enabled when neither pending nor otherwise disabled", () => {
    render(
      <AuthSubmitButton
        icon={LogIn}
        label="Sign in"
        pendingLabel="Signing in…"
        pending={false}
      />,
    );

    const button = screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
