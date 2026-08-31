import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FIELD_INPUT_CLASS, FieldLabel, FormError, SubmitButton } from "./form-field";

describe("FIELD_INPUT_CLASS", () => {
  it("carries the border, background and focus-ring the forms depend on", () => {
    // The point of the constant is that these survive as one string;
    // pinning the load-bearing utilities catches a partial edit.
    for (const cls of [
      "w-full",
      "rounded",
      "border-border",
      "bg-background",
      "text-sm",
      "focus:ring-1",
      "focus:ring-ring",
    ]) {
      expect(FIELD_INPUT_CLASS).toContain(cls);
    }
  });
});

describe("FieldLabel", () => {
  it("binds to its input via htmlFor", () => {
    render(<FieldLabel htmlFor="email">Email</FieldLabel>);
    expect(screen.getByText("Email")).toHaveAttribute("for", "email");
  });

  it("sits flush by default and takes the stacked gap with `mt`", () => {
    const { rerender } = render(<FieldLabel htmlFor="a">First</FieldLabel>);
    expect(screen.getByText("First").className).not.toContain("mt-3");
    rerender(
      <FieldLabel htmlFor="a" mt>
        Second
      </FieldLabel>,
    );
    expect(screen.getByText("Second").className).toContain("mt-3");
  });
});

describe("FormError", () => {
  it("renders the message when there is one", () => {
    render(<FormError message="Wrong password." />);
    expect(screen.getByText("Wrong password.")).toBeInTheDocument();
  });

  it("renders nothing for null, undefined or empty — callers drop it in unconditionally", () => {
    const { container, rerender } = render(<FormError message={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<FormError message={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<FormError message="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("applies the caller's spacing, since the block sits above the field in one form and below in another", () => {
    const { container } = render(<FormError message="x" className="mb-4" />);
    expect(container.firstElementChild?.className).toContain("mb-4");
  });
});

describe("SubmitButton", () => {
  it("shows the idle icon and label when not submitting", () => {
    render(
      <SubmitButton
        submitting={false}
        disabled={false}
        pendingLabel="Signing in…"
        icon={<span data-testid="idle-icon" />}
      >
        Sign in
      </SubmitButton>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Sign in");
    expect(screen.getByTestId("idle-icon")).toBeInTheDocument();
    expect(screen.queryByText("Signing in…")).not.toBeInTheDocument();
  });

  it("swaps to the pending label while submitting, dropping the idle icon", () => {
    render(
      <SubmitButton
        submitting
        disabled
        pendingLabel="Provisioning…"
        icon={<span data-testid="idle-icon" />}
      >
        Create my team agent
      </SubmitButton>,
    );
    expect(screen.getByText("Provisioning…")).toBeInTheDocument();
    expect(screen.queryByTestId("idle-icon")).not.toBeInTheDocument();
  });

  it("takes `disabled` from the caller, not from `submitting`", () => {
    // sign-in disables on empty fields too, so the two must stay
    // separate props rather than one being derived from the other.
    render(
      <SubmitButton submitting={false} disabled pendingLabel="…" icon={null}>
        Sign in
      </SubmitButton>,
    );
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("submits its form", () => {
    render(
      <SubmitButton submitting={false} disabled={false} pendingLabel="…" icon={null}>
        Go
      </SubmitButton>,
    );
    expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
  });
});
