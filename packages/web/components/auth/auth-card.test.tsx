import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KeyRound, LogIn } from "lucide-react";
import {
  API_NOT_CONFIGURED_MESSAGE,
  AuthCard,
  AuthCardFooter,
  AuthCardHeader,
  AuthError,
  AuthField,
  AuthSubmitButton,
} from "./auth-card";

describe("AuthCard", () => {
  it("submits the form it wraps", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <AuthCard onSubmit={onSubmit}>
        <button type="submit">Go</button>
      </AuthCard>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("AuthCardHeader", () => {
  it("renders the title as the page's h1", () => {
    render(<AuthCardHeader icon={LogIn} title="Sign in to beevibe" blurb="Email + password." />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in to beevibe");
  });

  it("accepts rich blurb content, which both pages use for the bv_u_ span", () => {
    render(
      <AuthCardHeader
        icon={KeyRound}
        title="t"
        blurb={
          <>
            Paste your <span className="font-mono">bv_u_</span> key.
          </>
        }
      />,
    );
    expect(screen.getByText("bv_u_")).toHaveClass("font-mono");
  });
});

describe("AuthField", () => {
  it("associates the label with the input so screen readers pair them", () => {
    render(<AuthField first id="email" label="Email" value="" onChange={() => {}} />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("id", "email");
  });

  it("reports typed text through onChange", async () => {
    const onChange = vi.fn();
    render(<AuthField first id="email" label="Email" value="" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Email"), "a");
    expect(onChange).toHaveBeenCalledWith("a");
  });

  // The top field sits flush under the header, which already carries mb-5;
  // every field below it supplies its own gap.
  it("omits the top margin on the first field and adds it on the rest", () => {
    const { container } = render(
      <>
        <AuthField first id="a" label="A" value="" onChange={() => {}} />
        <AuthField id="b" label="B" value="" onChange={() => {}} />
      </>,
    );
    const [a, b] = Array.from(container.querySelectorAll("label"));
    expect(a).not.toHaveClass("mt-3");
    expect(b).toHaveClass("mt-3");
  });

  it("applies the mono face only when asked", () => {
    const { container } = render(
      <>
        <AuthField first mono id="key" label="Key" value="" onChange={() => {}} />
        <AuthField id="email" label="Email" value="" onChange={() => {}} />
      </>,
    );
    expect(container.querySelector("#key")).toHaveClass("font-mono");
    expect(container.querySelector("#email")).not.toHaveClass("font-mono");
  });

  // These drive browser autofill and the on-screen keyboard, so they have to
  // survive the pass-through rather than being swallowed by the wrapper.
  it("passes input attributes through to the element", () => {
    render(
      <AuthField
        first
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        inputMode="text"
        minLength={8}
        spellCheck={false}
        placeholder="at least 8 characters"
        disabled
        value=""
        onChange={() => {}}
      />,
    );
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "new-password");
    expect(input).toHaveAttribute("minlength", "8");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("placeholder", "at least 8 characters");
    expect(input).toBeDisabled();
  });

  // A caller's className is merged, not substituted: the base input classes
  // carry the border, padding and focus ring, so losing them would leave an
  // unstyled box.
  it("merges a caller's className with the base input classes", () => {
    render(
      <AuthField
        first
        id="email"
        label="Email"
        className="tracking-wide"
        value=""
        onChange={() => {}}
      />,
    );
    const input = screen.getByLabelText("Email");
    expect(input).toHaveClass("tracking-wide");
    expect(input).toHaveClass("bg-background");
    expect(input).toHaveClass("focus:ring-1");
  });
});

describe("AuthError", () => {
  it("renders the message when there is one", () => {
    render(<AuthError message="Email or password is incorrect." />);
    expect(screen.getByText("Email or password is incorrect.")).toBeInTheDocument();
  });

  it("renders nothing when there is no error", () => {
    const { container } = render(<AuthError message={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an empty string, not an empty red row", () => {
    const { container } = render(<AuthError message="" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("AuthSubmitButton", () => {
  it("shows the idle label", () => {
    render(
      <AuthSubmitButton submitting={false} icon={LogIn} label="Sign in" busyLabel="Signing in…" />,
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("swaps to the busy label and disables itself while submitting", () => {
    render(
      <AuthSubmitButton submitting icon={LogIn} label="Sign in" busyLabel="Signing in…" />,
    );
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
  });

  // Callers pass only their field-validity condition; `submitting` disabling
  // the button is the component's job, so neither page has to remember the
  // `submitting || ...` half.
  it("disables on the caller's condition alone", () => {
    render(
      <AuthSubmitButton
        submitting={false}
        disabled
        icon={LogIn}
        label="Sign in"
        busyLabel="Signing in…"
      />,
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });
});

describe("AuthCardFooter", () => {
  it("renders the cross-link to the other auth page", () => {
    render(
      <AuthCardFooter>
        <a href="/sign-up">Sign up</a>
      </AuthCardFooter>,
    );
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/sign-up");
  });
});

describe("API_NOT_CONFIGURED_MESSAGE", () => {
  // Three submit handlers across the two pages show this; it is shared so
  // they cannot drift apart.
  it("is one sentence naming what is missing", () => {
    expect(API_NOT_CONFIGURED_MESSAGE).toBe("Web isn't configured to talk to an api server.");
  });
});
