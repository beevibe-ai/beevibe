import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/sign-in",
}));

vi.mock("@/lib/api/config", () => ({
  getUserKey: () => null,
  isApiConfigured: true,
  isWellFormedUserKey: (k: string) => k.startsWith("bv_u_"),
  setUserKey: vi.fn(),
}));

import { SignInClient } from "./sign-in-client";

/**
 * The two modes — email+password and paste-a-bv_u_-key — are the only
 * branching on this page, and they swap the header, the field set, the
 * submit's busy label and the handler all at once.
 */
describe("SignInClient mode switching", () => {
  it("starts in password mode with both credential fields", () => {
    render(<SignInClient />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByLabelText("User API key")).not.toBeInTheDocument();
  });

  it("swaps to the single key field and back", async () => {
    render(<SignInClient />);
    await userEvent.click(screen.getByRole("button", { name: /bv_u_ key/i }));

    expect(screen.getByLabelText("User API key")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /email \+ password/i }));
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByLabelText("User API key")).not.toBeInTheDocument();
  });

  it("holds submit disabled until the mode's own fields are filled", async () => {
    render(<SignInClient />);
    const submit = () => screen.getByRole("button", { name: "Sign in" });
    expect(submit()).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Email"), "alice@example.com");
    // Email alone is not enough — the password half is still empty.
    expect(submit()).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Password"), "hunter2");
    expect(submit()).toBeEnabled();
  });

  it("gates key mode on its own single field", async () => {
    render(<SignInClient />);
    await userEvent.click(screen.getByRole("button", { name: /bv_u_ key/i }));
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();

    await userEvent.type(screen.getByLabelText("User API key"), "bv_u_abc123");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("renders the key field in the mono face", async () => {
    render(<SignInClient />);
    await userEvent.click(screen.getByRole("button", { name: /bv_u_ key/i }));
    expect(screen.getByLabelText("User API key")).toHaveClass("font-mono");
  });
});
