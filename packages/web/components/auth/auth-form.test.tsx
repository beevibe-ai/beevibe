import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KeyRound, LogIn } from "lucide-react";

import { AuthAltAction, AuthCard, AuthError, AuthField, AuthSubmit } from "./auth-form";

describe("AuthError", () => {
  it("renders nothing when there is no error", () => {
    const { container } = render(<AuthError message={null} />);
    expect(container.textContent).toBe("");
  });

  it("shows the message when there is one", () => {
    render(<AuthError message="Email or password is incorrect." />);
    expect(screen.getByText("Email or password is incorrect.")).toBeTruthy();
  });
});

describe("AuthSubmit", () => {
  it("shows the idle label and stays enabled", () => {
    render(<AuthSubmit icon={LogIn} label="Sign in" busyLabel="Signing in…" submitting={false} />);
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("Sign in");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("swaps to the busy label and disables itself while submitting", () => {
    render(<AuthSubmit icon={LogIn} label="Sign in" busyLabel="Signing in…" submitting />);
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("Signing in…");
    expect(button.textContent).not.toContain("Sign in");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables on the caller's own validity rule too", () => {
    render(
      <AuthSubmit
        icon={LogIn}
        label="Sign in"
        busyLabel="Signing in…"
        submitting={false}
        disabled
      />,
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("AuthField", () => {
  it("associates the label with the input", () => {
    render(<AuthField id="email" label="Email" type="email" />);
    expect(screen.getByLabelText("Email").getAttribute("id")).toBe("email");
  });

  it("passes input attributes straight through", () => {
    render(
      <AuthField
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        minLength={8}
      />,
    );
    const input = screen.getByLabelText("Password");
    expect(input.getAttribute("type")).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("new-password");
    expect(input.getAttribute("minlength")).toBe("8");
  });

  it("drops the top margin on the field that sits under the header", () => {
    const { container } = render(<AuthField id="name" label="Name" first />);
    expect(container.querySelector("label")?.className).not.toContain("mt-3");
  });

  it("keeps the top margin on every later field", () => {
    const { container } = render(<AuthField id="name" label="Name" />);
    expect(container.querySelector("label")?.className).toContain("mt-3");
  });

  it("merges a caller's extra classes onto the shared input styling", () => {
    render(<AuthField id="key" label="Key" className="font-mono" />);
    const cls = screen.getByLabelText("Key").className;
    expect(cls).toContain("font-mono");
    expect(cls).toContain("focus:ring-ring");
  });
});

describe("AuthCard", () => {
  it("renders the title, blurb and its fields", () => {
    render(
      <AuthCard
        icon={KeyRound}
        title="Sign in to beevibe"
        blurb={<>Email + password.</>}
        onSubmit={() => {}}
      >
        <AuthField id="email" label="Email" first />
      </AuthCard>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sign in to beevibe");
    expect(screen.getByText("Email + password.")).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });

  it("submits through the caller's handler rather than navigating", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <AuthCard icon={LogIn} title="Sign in" blurb="" onSubmit={onSubmit}>
        <AuthSubmit icon={LogIn} label="Sign in" busyLabel="…" submitting={false} />
      </AuthCard>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

describe("AuthAltAction", () => {
  it("does not submit the enclosing form", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const onClick = vi.fn();
    render(
      <AuthCard icon={LogIn} title="Sign in" blurb="" onSubmit={onSubmit}>
        <AuthAltAction onClick={onClick}>Or use your key</AuthAltAction>
      </AuthCard>,
    );
    await userEvent.click(screen.getByText("Or use your key"));
    expect(onClick).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
