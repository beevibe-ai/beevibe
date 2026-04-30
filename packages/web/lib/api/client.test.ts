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

describe("api client", () => {
  describe("tasks", () => {
    it("list() hits /api/tasks with empty query when no filter is given", async () => {
      await api.tasks.list();
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/tasks", {
        query: {},
        signal: undefined,
      });
    });

    it("list({lifecycle, view, assignee_id}) forwards every filter to the query", async () => {
      await api.tasks.list({ lifecycle: "in_review", view: "mine", assignee_id: "a1" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/tasks", {
        query: { lifecycle: "in_review", view: "mine", assignee_id: "a1" },
        signal: undefined,
      });
    });

    it("forwards an AbortSignal when one is provided", async () => {
      const ac = new AbortController();
      await api.tasks.list({}, { signal: ac.signal });
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/tasks", {
        query: {},
        signal: ac.signal,
      });
    });

    it("get(id) URL-encodes the id", async () => {
      await api.tasks.get("task with spaces");
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/tasks/task%20with%20spaces", {
        signal: undefined,
      });
    });
  });

  describe("agents", () => {
    it("list() hits /api/agents", async () => {
      await api.agents.list();
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/agents", { signal: undefined });
    });

    it("get(id) URL-encodes the id", async () => {
      await api.agents.get("agt/slash");
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/agents/agt%2Fslash", {
        signal: undefined,
      });
    });
  });

  describe("sessions", () => {
    it("get(shortId) hits /api/sessions/:short", async () => {
      await api.sessions.get("sess-abc");
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/sessions/sess-abc", {
        signal: undefined,
      });
    });
  });

  describe("memory", () => {
    it("listFacts() defaults to empty filter", async () => {
      await api.memory.listFacts();
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/memory/facts", {
        query: {},
        signal: undefined,
      });
    });

    it("listFacts({scope}) forwards scope", async () => {
      await api.memory.listFacts({ scope: "team" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/memory/facts", {
        query: { scope: "team" },
        signal: undefined,
      });
    });
  });

  describe("promotions / mesh / threads / dashboard", () => {
    it("promotions.list() hits /api/promotions", async () => {
      await api.promotions.list();
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/promotions", { signal: undefined });
    });

    it("mesh.overview() hits /api/mesh with optional since", async () => {
      await api.mesh.overview({ since: "2026-04-30T00:00:00Z" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/mesh", {
        query: { since: "2026-04-30T00:00:00Z" },
        signal: undefined,
      });
    });

    it("threads.list() / threads.get(id)", async () => {
      await api.threads.list();
      expect(fetchJsonMock).toHaveBeenLastCalledWith("/api/threads", { signal: undefined });
      await api.threads.get("ch_1");
      expect(fetchJsonMock).toHaveBeenLastCalledWith("/api/threads/ch_1", { signal: undefined });
    });

    it("dashboard.summary() hits /api/dashboard", async () => {
      await api.dashboard.summary();
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/dashboard", { signal: undefined });
    });
  });
});
