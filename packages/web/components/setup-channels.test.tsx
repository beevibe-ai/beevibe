import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SetupChannels, type SetupBundle } from "./setup-channels";
import type { SegmentedTabOption } from "./segmented-tabs";

type Channel = "one" | "many";

const OPTIONS: readonly SegmentedTabOption<Channel>[] = [
  { id: "one", label: "One", hint: "a single command" },
  { id: "many", label: "Many", hint: "several commands" },
];

const BUNDLES: Record<Channel, SetupBundle> = {
  one: {
    prelude: <p>do this first</p>,
    steps: [{ label: "Install", command: "brew install thing" }],
    epilogue: <p>then restart</p>,
  },
  many: {
    steps: [
      { label: "Download", command: "curl -O thing" },
      { label: "Register", command: "thing setup" },
    ],
  },
};

function renderChannels(props: Partial<Parameters<typeof SetupChannels<Channel>>[0]> = {}) {
  return render(
    <SetupChannels options={OPTIONS} initial="one" buildBundle={(c) => BUNDLES[c]} {...props} />,
  );
}

describe("SetupChannels", () => {
  it("renders the initially selected channel's commands", () => {
    renderChannels();
    expect(screen.getByText("brew install thing")).toBeTruthy();
    expect(screen.queryByText("curl -O thing")).toBeNull();
  });

  it("shows the prelude and epilogue around the commands", () => {
    renderChannels();
    expect(screen.getByText("do this first")).toBeTruthy();
    expect(screen.getByText("then restart")).toBeTruthy();
  });

  it("omits the prelude and epilogue slots for a bundle that has neither", async () => {
    renderChannels({ initial: "many" });
    expect(screen.queryByText("do this first")).toBeNull();
    expect(screen.queryByText("then restart")).toBeNull();
  });

  it("swaps the commands when another channel is picked", async () => {
    renderChannels();
    await userEvent.click(screen.getByText("Many"));
    expect(screen.getByText("curl -O thing")).toBeTruthy();
    expect(screen.queryByText("brew install thing")).toBeNull();
  });

  it("numbers every step by default", () => {
    renderChannels();
    expect(screen.getByText("1. Install")).toBeTruthy();
  });

  it("under multi-step numbering, leaves a lone command unnumbered", () => {
    // "1. Install" on a single-command channel implies a step 2 that never
    // comes — the MCP instructions opt out for exactly this reason.
    renderChannels({ numbering: "multi-step" });
    expect(screen.getByText("Install")).toBeTruthy();
    expect(screen.queryByText("1. Install")).toBeNull();
  });

  it("under multi-step numbering, still numbers a channel with several", () => {
    renderChannels({ initial: "many", numbering: "multi-step" });
    expect(screen.getByText("1. Download")).toBeTruthy();
    expect(screen.getByText("2. Register")).toBeTruthy();
  });

  it("accepts a lazy initial channel, calling it once rather than per render", async () => {
    let calls = 0;
    renderChannels({
      initial: () => {
        calls += 1;
        return "many";
      },
    });
    expect(screen.getByText("curl -O thing")).toBeTruthy();
    await userEvent.click(screen.getByText("One"));
    expect(screen.getByText("brew install thing")).toBeTruthy();
    expect(calls).toBe(1);
  });
});
