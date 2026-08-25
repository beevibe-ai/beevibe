import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogIn, Sparkles } from "lucide-react";

import { AuthCard, AuthError, AuthField, AuthSubmitButton } from "./auth-card";

describe("AuthCard", () => {
  it("submits the form when the submit button is pressed", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <AuthCard icon={LogIn} title="Sign in" blurb="blurb" onSubmit={onSubmit} footer="footer">
        <AuthSubmitButton icon={LogIn} label="Sign in" pendingLabel="…" pending={false} />
      </AuthCard>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("AuthField", () => {
  it("wires the label to its input so clicking the label focuses the field", async () => {
    render(<AuthField id="email" label="Email" type="email" />);
    await userEvent.click(screen.getByText("Email"));
    expect(screen.getByLabelText("Email")).toHaveFocus();
  });

  it("keeps caller classes alongside the shared field styling", () => {
    render(<AuthField id="key" label="Key" className="font-mono" />);
    const input = screen.getByLabelText("Key");
    expect(input.className).toContain("font-mono");
    expect(input.className).toContain("bg-background");
  });

  it("only spaces itself from a field above when asked", () => {
    const { rerender } = render(<AuthField id="a" label="First" />);
    expect(screen.getByText("First").className).not.toContain("mt-3");
    rerender(<AuthField id="a" label="First" spaced />);
    expect(screen.getByText("First").className).toContain("mt-3");
  });
});

describe("AuthError", () => {
  it("renders nothing when there is no error", () => {
    const { container } = render(<AuthError message={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the message when there is one", () => {
    render(<AuthError message="Email or password is incorrect." />);
    expect(screen.getByText("Email or password is incorrect.")).toBeInTheDocument();
  });
});

describe("AuthSubmitButton", () => {
  it("swaps to the pending label and disables while in flight", () => {
    render(
      <AuthSubmitButton
        icon={Sparkles}
        label="Create my team agent"
        pendingLabel="Provisioning…"
        pending
        disabled
      />,
    );
    const button = screen.getByRole("button", { name: "Provisioning…" });
    expect(button).toBeDisabled();
    expect(screen.queryByText("Create my team agent")).not.toBeInTheDocument();
  });

  it("can be enabled while showing its idle label", () => {
    render(
      <AuthSubmitButton icon={LogIn} label="Sign in" pendingLabel="Signing in…" pending={false} />,
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});
