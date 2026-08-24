import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogIn } from "lucide-react";

import { AuthCard, AuthError, AuthField, AuthSubmitButton } from "./auth-form";

describe("AuthField", () => {
  it("wires the label to the input", () => {
    render(<AuthField first id="email" label="Email" type="email" />);
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });

  it("stacks fields with a top margin on every one but the first", () => {
    const { container } = render(
      <>
        <AuthField first id="a" label="First" />
        <AuthField id="b" label="Second" />
      </>,
    );
    const [first, second] = Array.from(container.querySelectorAll("label"));
    expect(first?.className).not.toContain("mt-3");
    expect(second?.className).toContain("mt-3");
  });

  it("merges a caller's class onto the shared input styling", () => {
    render(<AuthField first id="key" label="User API key" className="font-mono" />);
    const input = screen.getByLabelText("User API key");
    expect(input.className).toContain("font-mono");
    expect(input.className).toContain("border-border");
  });
});

describe("AuthError", () => {
  it("renders nothing without a message", () => {
    const { container } = render(<AuthError message={null} />);
    expect(container.textContent).toBe("");
  });

  it("shows the message when there is one", () => {
    render(<AuthError message="Email or password is incorrect." />);
    expect(screen.getByText("Email or password is incorrect.")).toBeTruthy();
  });
});

describe("AuthSubmitButton", () => {
  it("swaps to the pending label while in flight", () => {
    const { rerender } = render(
      <AuthSubmitButton
        icon={LogIn}
        label="Sign in"
        pendingLabel="Signing in…"
        pending={false}
        disabled={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();

    rerender(
      <AuthSubmitButton
        icon={LogIn}
        label="Sign in"
        pendingLabel="Signing in…"
        pending
        disabled
      />,
    );
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.textContent).toContain("Signing in…");
    expect(button.disabled).toBe(true);
  });
});

describe("AuthCard", () => {
  it("submits the form the fields live in", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <AuthCard
        icon={LogIn}
        title="Sign in to beevibe"
        description="Email + password."
        onSubmit={onSubmit}
        footer={<span>New here?</span>}
      >
        <AuthField first id="email" label="Email" />
        <AuthSubmitButton
          icon={LogIn}
          label="Sign in"
          pendingLabel="Signing in…"
          pending={false}
          disabled={false}
        />
      </AuthCard>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByText("New here?")).toBeTruthy();
  });
});
