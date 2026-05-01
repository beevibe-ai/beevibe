import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", () => ({
  fetchJson: vi.fn(),
  ApiError: class ApiError extends Error {},
  ApiNotConfigured: class ApiNotConfigured extends Error {},
}));

import { api } from "./client";
import { fetchJson } from "./http";

const fetchJsonMock = vi.mocked(fetchJson);

beforeEach(() => {
  fetchJsonMock.mockReset();
  fetchJsonMock.mockResolvedValue([]);
});

describe("api client (reads)", () => {
  describe("tasks", () => {
    it("list() hits /task with empty query when no filter is given", async () => {
      await api.tasks.list();
      expect(fetchJsonMock).toHaveBeenCalledWith("/task", {
        query: {},
        signal: undefined,
      });
    });

    it("list({lifecycle, view, assignee_id}) forwards every filter to the query", async () => {
      await api.tasks.list({ lifecycle: "in_review", view: "mine", assignee_id: "a1" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/task", {
        query: { lifecycle: "in_review", view: "mine", assignee_id: "a1" },
        signal: undefined,
      });
    });

    it("forwards an AbortSignal when one is provided", async () => {
      const ac = new AbortController();
      await api.tasks.list({}, { signal: ac.signal });
      expect(fetchJsonMock).toHaveBeenCalledWith("/task", {
        query: {},
        signal: ac.signal,
      });
    });

    it("get(id) URL-encodes the id", async () => {
      await api.tasks.get("task with spaces");
      expect(fetchJsonMock).toHaveBeenCalledWith("/task/task%20with%20spaces", {
        signal: undefined,
      });
    });
  });

  describe("agents", () => {
    it("list() hits /agent", async () => {
      await api.agents.list();
      expect(fetchJsonMock).toHaveBeenCalledWith("/agent", { signal: undefined });
    });

    it("get(id) URL-encodes the id", async () => {
      await api.agents.get("agt/slash");
      expect(fetchJsonMock).toHaveBeenCalledWith("/agent/agt%2Fslash", {
        signal: undefined,
      });
    });
  });

  describe("sessions", () => {
    it("get(shortId) hits /session/:short", async () => {
      await api.sessions.get("abc123");
      expect(fetchJsonMock).toHaveBeenCalledWith("/session/abc123", {
        signal: undefined,
      });
    });
  });

  describe("memory", () => {
    it("listFacts() defaults to empty filter", async () => {
      await api.memory.listFacts();
      expect(fetchJsonMock).toHaveBeenCalledWith("/memory/fact", {
        query: {},
        signal: undefined,
      });
    });

    it("listFacts({scope}) forwards scope", async () => {
      await api.memory.listFacts({ scope: "team" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/memory/fact", {
        query: { scope: "team" },
        signal: undefined,
      });
    });
  });

  describe("deferred surfaces (paths set; backend not yet shipped)", () => {
    it("promotions.list() hits /promotion", async () => {
      await api.promotions.list();
      expect(fetchJsonMock).toHaveBeenCalledWith("/promotion", { signal: undefined });
    });

    it("mesh.overview() hits /mesh with optional since", async () => {
      await api.mesh.overview({ since: "2026-04-30T00:00:00Z" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/mesh", {
        query: { since: "2026-04-30T00:00:00Z" },
        signal: undefined,
      });
    });

    it("dashboard.summary() hits /dashboard", async () => {
      await api.dashboard.summary();
      expect(fetchJsonMock).toHaveBeenCalledWith("/dashboard", { signal: undefined });
    });
  });
});
