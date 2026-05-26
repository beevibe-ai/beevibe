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
    it("approve(id) POSTs to /task/:id/approve with empty body by default", async () => {
      await api.tasks.approve("t_1");
      expect(fetchJsonMock).toHaveBeenCalledWith("/task/t_1/approve", {
        method: "POST",
        body: {},
      });
    });

    it("approve forwards optional result_summary", async () => {
      await api.tasks.approve("t_1", { result_summary: "lgtm" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/task/t_1/approve", {
        method: "POST",
        body: { result_summary: "lgtm" },
      });
    });

    it("reject(id) POSTs to /task/:id/reject with empty body by default", async () => {
      await api.tasks.reject("t_1");
      expect(fetchJsonMock).toHaveBeenCalledWith("/task/t_1/reject", {
        method: "POST",
        body: {},
      });
    });

    it("reject forwards optional result_summary", async () => {
      await api.tasks.reject("t_1", { result_summary: "wrong scope" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/task/t_1/reject", {
        method: "POST",
        body: { result_summary: "wrong scope" },
      });
    });

    it("revise(id, {feedback}) POSTs to /task/:id/revise with the feedback body", async () => {
      await api.tasks.revise("t_1", { feedback: "needs more tests" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/task/t_1/revise", {
        method: "POST",
        body: { feedback: "needs more tests" },
      });
    });

    it("cancel(id) POSTs to /task/:id/cancel with empty body by default", async () => {
      await api.tasks.cancel("t_1");
      expect(fetchJsonMock).toHaveBeenCalledWith("/task/t_1/cancel", {
        method: "POST",
        body: {},
      });
    });

    it("cancel(id, {reason}) forwards reason", async () => {
      await api.tasks.cancel("t_1", { reason: "scope changed" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/task/t_1/cancel", {
        method: "POST",
        body: { reason: "scope changed" },
      });
    });

    it("create({title}) POSTs to /api/tasks", async () => {
      await api.tasks.create({ title: "wire it" });
      expect(fetchJsonMock).toHaveBeenCalledWith("/task", {
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
      expect(fetchJsonMock).toHaveBeenCalledWith("/task", {
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

  describe("escalations", () => {
    it("resolve(id, {source: 'human', ...}) POSTs to /escalation/:id/resolve", async () => {
      await api.escalations.resolve("e_1", {
        source: "human",
        title: "Adopt option C",
        description: "Splits the diff",
      });
      expect(fetchJsonMock).toHaveBeenCalledWith("/escalation/e_1/resolve", {
        method: "POST",
        body: {
          source: "human",
          title: "Adopt option C",
          description: "Splits the diff",
        },
      });
    });

    it("resolve forwards initiator/counterparty selectors", async () => {
      await api.escalations.resolve("e_1", {
        source: "initiator",
        source_index: 0,
        edited_title: "tweaked",
        resolution_notes: "confirmed via slack",
      });
      expect(fetchJsonMock).toHaveBeenCalledWith("/escalation/e_1/resolve", {
        method: "POST",
        body: {
          source: "initiator",
          source_index: 0,
          edited_title: "tweaked",
          resolution_notes: "confirmed via slack",
        },
      });
    });
  });

  describe("newsletter", () => {
    it("subscribe(input) POSTs to /newsletter/subscribe", async () => {
      await api.newsletter.subscribe({
        email: "alice@example.com",
        source: "community",
        website: "",
      });
      expect(fetchJsonMock).toHaveBeenCalledWith("/newsletter/subscribe", {
        method: "POST",
        body: {
          email: "alice@example.com",
          source: "community",
          website: "",
        },
      });
    });
  });
});
