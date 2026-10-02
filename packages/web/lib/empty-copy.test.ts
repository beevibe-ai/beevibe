import { describe, expect, it } from "vitest";
import { apiNotConfiguredCopy, loadFailedCopy } from "./empty-copy";

describe("apiNotConfiguredCopy", () => {
  it("names the API server, never the MCP server", () => {
    const copy = apiNotConfiguredCopy("tasks");
    expect(copy.title).toBe("API not configured");
    expect(copy.description).toBe(
      "Set NEXT_PUBLIC_BV_API_URL and run the API server to load tasks.",
    );
    expect(copy.description).not.toMatch(/MCP/);
  });

  it("drops the target phrase in verbatim so callers control the article", () => {
    expect(apiNotConfiguredCopy("this work product").description).toContain(
      "to load this work product.",
    );
  });
});

describe("loadFailedCopy", () => {
  it("titles on the bare noun and capitalizes it in the sentence", () => {
    const copy = loadFailedCopy("mesh activity");
    expect(copy.title).toBe("Couldn't load mesh activity");
    expect(copy.description).toBe(
      "Mesh activity could not be fetched. Check the API server logs.",
    );
  });

  it("echoes an id when the page is about one row", () => {
    expect(loadFailedCopy("work product", "wp_42").description).toBe(
      "Work product wp_42 could not be fetched. Check the API server logs.",
    );
  });

  it("leaves an already-capitalized noun alone", () => {
    expect(loadFailedCopy("Layer A telemetry").title).toBe(
      "Couldn't load Layer A telemetry",
    );
  });
});
