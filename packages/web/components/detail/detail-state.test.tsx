import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Users } from "lucide-react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { DetailStateMessage, detailState } from "./detail-state";

interface Row {
  name: string;
}

const loaded = { data: { name: "Design doc" }, isLoading: false, isError: false };
const loading = { data: undefined, isLoading: true, isError: false };
const failed = { data: undefined, isLoading: false, isError: true };
const settledEmpty = { data: undefined, isLoading: false, isError: false };

function state(query: { data: Row | undefined; isLoading: boolean; isError: boolean }) {
  return detailState({ noun: "work product", id: "wp_42", query });
}

describe("detailState", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("hands back the row once the fetch succeeded", () => {
    const s = state(loaded);
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") expect(s.data.name).toBe("Design doc");
  });

  it("reports loading without copy of its own", () => {
    expect(state(loading)).toEqual({ kind: "loading" });
  });

  // With no API URL the fetch was never going to succeed, so "couldn't
  // load" would send the reader after the wrong cause.
  it("reports an unconfigured API ahead of a failed fetch", () => {
    apiState.isApiConfigured = false;
    expect(state(failed).kind).toBe("unconfigured");
  });

  // An unconfigured API also wins over `isLoading`, which react-query
  // leaves true for a query it never enabled.
  it("reports an unconfigured API ahead of loading", () => {
    apiState.isApiConfigured = false;
    expect(state(loading).kind).toBe("unconfigured");
  });

  it("derives the unconfigured message from the noun", () => {
    apiState.isApiConfigured = false;
    const s = state(failed);
    expect(s.kind === "unconfigured" && s.description).toBe(
      "Set NEXT_PUBLIC_BV_API_URL and run the API server to load this work product.",
    );
  });

  it("derives the error message from the noun and echoes the id", () => {
    const s = state(failed);
    expect(s.kind === "error" && s.title).toBe("Couldn't load work product");
    expect(s.kind === "error" && s.description).toBe(
      "Work product wp_42 could not be fetched. Check the API server logs.",
    );
  });

  // A query can settle without erroring and still hand back nothing (a
  // 404 mapped to undefined). That has to land on the error branch, not
  // report ready with a missing row.
  it("treats settled-but-empty as a failed fetch", () => {
    expect(state(settledEmpty).kind).toBe("error");
  });

  // The unconfigured branch takes the caller's icon so each surface can
  // keep its own; the error branch is always AlertTriangle.
  it("passes the caller's icon through on the unconfigured branch only", () => {
    apiState.isApiConfigured = false;
    const unconfigured = detailState({
      noun: "room",
      id: "r_1",
      icon: Users,
      query: failed,
    });
    expect(unconfigured.kind === "unconfigured" && unconfigured.icon).toBe(Users);

    apiState.isApiConfigured = true;
    const error = detailState({ noun: "room", id: "r_1", icon: Users, query: failed });
    expect(error.kind === "error" && error.icon).not.toBe(Users);
  });
});

describe("DetailStateMessage", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the title and description of a message branch", () => {
    const s = state(failed);
    if (s.kind !== "error") throw new Error("expected the error branch");
    render(<DetailStateMessage state={s} />);
    expect(screen.getByText("Couldn't load work product")).toBeInTheDocument();
    expect(
      screen.getByText(/Work product wp_42 could not be fetched\. Check the API server logs\./),
    ).toBeInTheDocument();
  });
});
