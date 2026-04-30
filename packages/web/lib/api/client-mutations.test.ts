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
  fetchJsonMock.mockResolvedValue({});
});

describe("api mutations", () => {
  describe("tasks", () => {
    it("approve(id, {action}) POSTs to /api/tasks/:id/approve with body", async () => {
      await api.tasks.approve("t_1", { action: "approve" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/tasks/t_1/approve", {
        method: "POST",
        body: { action: "approve" },
      });
    });

    it("approve forwards optional result_summary", async () => {
      await api.tasks.approve("t_1", { action: "revise", result_summary: "needs more tests" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/tasks/t_1/approve", {
        method: "POST",
        body: { action: "revise", result_summary: "needs more tests" },
      });
    });

    it("cancel(id) POSTs to /api/tasks/:id/cancel with empty body by default", async () => {
      await api.tasks.cancel("t_1");
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/tasks/t_1/cancel", {
        method: "POST",
        body: {},
      });
    });

    it("cancel(id, {force, reason}) forwards both", async () => {
      await api.tasks.cancel("t_1", { force: true, reason: "scope changed" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/tasks/t_1/cancel", {
        method: "POST",
        body: { force: true, reason: "scope changed" },
      });
    });

    it("create({title}) POSTs to /api/tasks", async () => {
      await api.tasks.create({ title: "wire it" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/tasks", {
        method: "POST",
        body: { title: "wire it" },
      });
    });

    it("create forwards full input", async () => {
      await api.tasks.create({
        title: "wire it",
        description: "hook the kanban",
        priority: "high",
        assignee_id: "agt_1",
        parent_task_id: "t_root",
      });
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/tasks", {
        method: "POST",
        body: {
          title: "wire it",
          description: "hook the kanban",
          priority: "high",
          assignee_id: "agt_1",
          parent_task_id: "t_root",
        },
      });
    });
  });

  describe("sessions", () => {
    it("cancel(shortId) POSTs to /api/sessions/:short/cancel", async () => {
      await api.sessions.cancel("sess_abc");
      expect(fetchJsonMock).toHaveBeenCalledWith("/api/sessions/sess_abc/cancel", {
        method: "POST",
      });
    });

    it("cancel URL-encodes shortId", async () => {
      await api.sessions.cancel("sess/with/slash");
      expect(fetchJsonMock).toHaveBeenCalledWith(
        "/api/sessions/sess%2Fwith%2Fslash/cancel",
        { method: "POST" },
      );
    });
  });
});
