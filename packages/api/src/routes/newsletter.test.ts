import express, { json } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNewsletterRouter } from "./newsletter.js";

describe("newsletter routes", () => {
  const query = vi.fn();

  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  function makeApp() {
    const app = express();
    app.use(json());
    app.use(createNewsletterRouter({ pool: { query } }));
    return app;
  }

  it("upserts a normalized email", async () => {
    const res = await request(makeApp())
      .post("/newsletter/subscribe")
      .send({ email: " Alice@Example.COM ", source: "community" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      subscriber: { email: "alice@example.com", source: "community" },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      expect.stringMatching(/^nl_[a-f0-9]{32}$/),
      "alice@example.com",
      "community",
    ]);
  });

  it("rejects invalid email input", async () => {
    const res = await request(makeApp())
      .post("/newsletter/subscribe")
      .send({ email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_email");
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts honeypot submissions without persisting", async () => {
    const res = await request(makeApp())
      .post("/newsletter/subscribe")
      .send({ email: "bot@example.com", website: "https://spam.test" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(query).not.toHaveBeenCalled();
  });
});
