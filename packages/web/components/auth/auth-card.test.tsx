import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogIn, Sparkles } from "lucide-react";

import { AuthCard, AuthError, AuthSubmitButton } from "./auth-card";

describe("AuthCard", () => {
  it("submits the form when the card's button is pressed", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <AuthCard icon={LogIn} title="Sign in" blurb="blurb" onSubmit={onSubmit}>
        <AuthSubmitButton icon={LogIn} label="Sign in" pendingLabel="…" pending={false} />
      </AuthCard>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("renders the title and blurb it was given", () => {
    render(
      <AuthCard icon={LogIn} title="Sign up for beevibe" blurb={<>Hello there</>} onSubmit={() => {}}>
        <span />
      </AuthCard>,
    );
    expect(screen.getByRole("heading", { name: "Sign up for beevibe" })).toBeTruthy();
    expect(screen.getByText("Hello there")).toBeTruthy();
  });
});

describe("AuthError", () => {
  it("renders nothing when there's no error", () => {
    const { container } = render(<AuthError message={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the message when there is one", () => {
    render(<AuthError message="Email or password is incorrect." />);
    expect(screen.getByText("Email or password is incorrect.")).toBeTruthy();
  });
});

describe("AuthSubmitButton", () => {
  it("shows the idle label at rest", () => {
    render(
      <AuthSubmitButton
        icon={Sparkles}
        label="Create my team agent"
        pendingLabel="Provisioning…"
        pending={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Create my team agent" })).toBeTruthy();
  });

  it("swaps to the pending label and locks out a second submit", () => {
    render(
      <AuthSubmitButton
        icon={Sparkles}
        label="Create my team agent"
        pendingLabel="Provisioning…"
        pending
      />,
    );
    const button = screen.getByRole("button", { name: "Provisioning…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables on the caller's own reason while idle", () => {
    render(
      <AuthSubmitButton
        icon={LogIn}
        label="Sign in"
        pendingLabel="…"
        pending={false}
        disabled
      />,
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
