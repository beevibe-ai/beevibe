import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { KeyRound, LogIn } from "lucide-react";
import {
  AUTH_INPUT_CLASS,
  AuthCard,
  AuthError,
  AuthField,
  AuthSubmitButton,
} from "./auth-form";

describe("AuthCard", () => {
  it("renders as a form so Enter submits", () => {
    const { container } = render(
      <AuthCard icon={LogIn} title="Sign in" description="blurb" onSubmit={() => {}}>
        <span>body</span>
      </AuthCard>,
    );
    expect(container.querySelector("form")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sign in");
    expect(screen.getByText("blurb")).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
  });
});

describe("AuthField", () => {
  it("ties the label to the input and keeps the shared input class", () => {
    render(<AuthField id="email" label="Email" type="email" />);
    const input = screen.getByLabelText("Email");
    expect(input.getAttribute("id")).toBe("email");
    expect(input.getAttribute("type")).toBe("email");
    for (const cls of AUTH_INPUT_CLASS.split(" ")) {
      expect(input.className).toContain(cls);
    }
  });

  it("adds the stacking margin only when `spaced`", () => {
    const { rerender, container } = render(<AuthField id="a" label="A" />);
    expect(container.querySelector("label")?.className).not.toContain("mt-3");
    rerender(<AuthField id="a" label="A" spaced />);
    expect(container.querySelector("label")?.className).toContain("mt-3");
  });

  it("appends a caller class rather than replacing the shared one", () => {
    render(<AuthField id="key" label="Key" className="font-mono" />);
    const input = screen.getByLabelText("Key");
    expect(input.className).toContain("font-mono");
    expect(input.className).toContain("bg-background");
  });
});

describe("AuthError", () => {
  it("shows the message", () => {
    render(<AuthError message="Email or password is incorrect." />);
    expect(screen.getByText("Email or password is incorrect.")).toBeTruthy();
  });
});

describe("AuthSubmitButton", () => {
  it("swaps label for the pending label while in flight", () => {
    const { rerender } = render(
      <AuthSubmitButton icon={KeyRound} label="Sign in" pending={false} pendingLabel="Signing in…" />,
    );
    expect(screen.getByRole("button").textContent).toBe("Sign in");
    rerender(
      <AuthSubmitButton icon={KeyRound} label="Sign in" pending pendingLabel="Signing in…" />,
    );
    expect(screen.getByRole("button").textContent).toBe("Signing in…");
  });

  it("honours `disabled` independently of `pending`", () => {
    render(
      <AuthSubmitButton
        icon={KeyRound}
        label="Sign in"
        pending={false}
        pendingLabel="Signing in…"
        disabled
      />,
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
