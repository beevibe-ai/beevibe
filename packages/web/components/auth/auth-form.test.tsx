import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { KeyRound, LogIn } from "lucide-react";

import { AuthCard, AuthError, AuthField, AuthSubmit } from "./auth-form";

describe("AuthError", () => {
  it("renders nothing without a message", () => {
    const { container } = render(<AuthError message={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the message when there is one", () => {
    render(<AuthError message="Email or password is incorrect." />);
    expect(screen.getByText("Email or password is incorrect.")).toBeTruthy();
  });
});

describe("AuthField", () => {
  it("ties the label to its input so clicking the label focuses it", () => {
    render(<AuthField id="email" label="Email" type="email" />);
    expect(screen.getByLabelText("Email").id).toBe("email");
  });

  it("drops the top margin only on the first field", () => {
    const { container: first } = render(<AuthField id="a" label="A" first />);
    const { container: rest } = render(<AuthField id="b" label="B" />);
    expect(first.querySelector("label")!.className).not.toContain("mt-3");
    expect(rest.querySelector("label")!.className).toContain("mt-3");
  });

  it("forwards arbitrary input attributes", () => {
    render(<AuthField id="key" label="Key" mono spellCheck={false} placeholder="bv_u_..." />);
    const input = screen.getByLabelText("Key") as HTMLInputElement;
    expect(input.placeholder).toBe("bv_u_...");
    // jsdom does not implement the spellcheck IDL property — read the attribute.
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.className).toContain("font-mono");
  });
});

describe("AuthSubmit", () => {
  it("shows the resting label when idle", () => {
    render(
      <AuthSubmit
        icon={LogIn}
        label="Sign in"
        pendingLabel="Signing in…"
        submitting={false}
        disabled={false}
      />,
    );
    expect(screen.getByRole("button", { name: /Sign in/ })).toBeTruthy();
  });

  it("swaps to the pending label and honours disabled while in flight", () => {
    render(
      <AuthSubmit icon={LogIn} label="Sign in" pendingLabel="Signing in…" submitting disabled />,
    );
    const button = screen.getByRole("button", { name: /Signing in/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("AuthCard", () => {
  it("renders header, children and footer, and submits the form", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <AuthCard
        onSubmit={onSubmit}
        icon={KeyRound}
        title="Sign in to beevibe"
        description="Email + password."
        footer={<span>New here?</span>}
      >
        <AuthField id="email" label="Email" first />
        <AuthSubmit
          icon={LogIn}
          label="Sign in"
          pendingLabel="Signing in…"
          submitting={false}
          disabled={false}
        />
      </AuthCard>,
    );
    expect(screen.getByRole("heading", { name: "Sign in to beevibe" })).toBeTruthy();
    expect(screen.getByText("Email + password.")).toBeTruthy();
    expect(screen.getByText("New here?")).toBeTruthy();

    screen.getByRole("button", { name: /Sign in/ }).click();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
