import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ShareLinkBox, signUpInviteLink } from "./share-link-box";

describe("signUpInviteLink", () => {
  it("carries just the email for a plain teammate invite", () => {
    expect(signUpInviteLink("alice@example.com")).toBe(
      `${window.location.origin}/sign-up?email=alice%40example.com`,
    );
  });

  it("carries the room first when the invite auto-joins one", () => {
    expect(signUpInviteLink("alice@example.com", "room_abc")).toBe(
      `${window.location.origin}/sign-up?room=room_abc&email=alice%40example.com`,
    );
  });

  it("escapes the characters an email is allowed to contain", () => {
    const link = signUpInviteLink("a.b+c@ex-ample.co.uk");
    expect(link).toContain("email=a.b%2Bc%40ex-ample.co.uk");
    expect(new URL(link).searchParams.get("email")).toBe("a.b+c@ex-ample.co.uk");
  });
});

describe("ShareLinkBox", () => {
  it("shows the link read-only next to a copy button", () => {
    render(<ShareLinkBox link="https://beevibe.test/sign-up?email=a%40b.c" description="Send this:" />);
    const input = screen.getByDisplayValue("https://beevibe.test/sign-up?email=a%40b.c");
    expect((input as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByRole("button").textContent).toBe("Copy");
    expect(screen.getByText("Send this:")).toBeTruthy();
  });
});
