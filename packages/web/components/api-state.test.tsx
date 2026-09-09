import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { NotConfigured, fetchErrorCopy, notConfiguredCopy } from "./api-state";

describe("notConfiguredCopy", () => {
  it("names the condition, not an empty account", () => {
    // The three pages that used to title this "No mesh asks yet" /
    // "No facts learned yet" / "No promotions yet" sent readers looking
    // for missing data when the build simply had no API URL.
    expect(notConfiguredCopy("mesh activity").title).toBe("API not configured");
  });

  it("completes the sentence with the caller's subject", () => {
    expect(notConfiguredCopy("mesh activity").description).toBe(
      "Set NEXT_PUBLIC_BV_API_URL and run the API server to load mesh activity.",
    );
  });

  it("calls the process the API server everywhere", () => {
    // It was variously "the api server", "the API server" and "the MCP
    // server" across call sites. One process, one name.
    for (const subject of ["tasks", "this room", "settings"]) {
      expect(notConfiguredCopy(subject).description).toContain("run the API server");
      expect(notConfiguredCopy(subject).description).not.toMatch(/MCP server|the api server/);
    }
  });
});

describe("fetchErrorCopy", () => {
  it("echoes the id and points at the server logs", () => {
    expect(fetchErrorCopy("work product", "wp_42")).toEqual({
      title: "Couldn't load work product",
      description: "Work product wp_42 could not be fetched. Check the API server logs.",
    });
  });

  it("drops the description when there is no single row to name", () => {
    expect(fetchErrorCopy("promotions").description).toBeUndefined();
  });
});

describe("NotConfigured", () => {
  it("renders the canonical title and description", () => {
    render(<NotConfigured subject="runtimes" />);
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(
      screen.getByText("Set NEXT_PUBLIC_BV_API_URL and run the API server to load runtimes."),
    ).toBeInTheDocument();
  });
});
