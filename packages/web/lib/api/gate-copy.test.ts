import { describe, expect, it } from "vitest";
import { apiNotConfiguredCopy, loadFailedCopy } from "./gate-copy";

describe("apiNotConfiguredCopy", () => {
  it("names the API server — the process that actually exists", () => {
    const { description } = apiNotConfiguredCopy("agents");
    expect(description).toContain("run the API server");
    // The six call sites this replaced said "MCP server", which is a
    // route on the API server, not a process anyone can start.
    expect(description).not.toMatch(/MCP server/i);
  });

  it("titles the state as a configuration problem, never as empty data", () => {
    expect(apiNotConfiguredCopy("memory").title).toBe("API not configured");
  });

  it("completes the sentence with the caller's subject", () => {
    expect(apiNotConfiguredCopy("mesh activity").description).toBe(
      "Set NEXT_PUBLIC_BV_API_URL and run the API server to load mesh activity.",
    );
  });
});

describe("loadFailedCopy", () => {
  it("echoes the id back so a failed fetch is identifiable", () => {
    expect(loadFailedCopy("work product", "wp_42")).toEqual({
      title: "Couldn't load work product",
      description: "Work product wp_42 could not be fetched. Check the API server logs.",
    });
  });

  it("omits the description when there is no single row to name", () => {
    expect(loadFailedCopy("tasks")).toEqual({ title: "Couldn't load tasks" });
  });

  it("capitalizes only the first letter of a multi-word noun", () => {
    expect(loadFailedCopy("work product", "x").description).toMatch(/^Work product x/);
  });
});
