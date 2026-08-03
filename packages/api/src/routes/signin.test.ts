/**
 * `POST /signin` — unit tests with a vitest fake PersonRepository.
 *
 * The route's whole job is deciding which of four responses an
 * (email, password) pair earns, so the tests are organised around that
 * decision table. The 401-collapsing behaviour is deliberate — three
 * distinct failures must be indistinguishable on the wire or the
 * endpoint becomes an email-existence oracle.
 */
import express, { json } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person, PersonRepository } from "@beevibe/core";
import { SIGNIN_NO_PASSWORD_SET, hashPassword } from "@beevibe/core/auth";
import { createSigninRouter } from "./signin.js";

const PASSWORD = "correct-horse-battery";

function makePersonRepo(): PersonRepository {
  return {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findByApiKey: vi.fn(),
    findManyByIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function fakePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: "person_1",
    name: "Ada",
    email: "ada@example.com",
    api_key: "bv_u_secret",
    capability_network_enabled: true,
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function makeApp(personRepo: PersonRepository, enabled?: boolean) {
  const app = express();
  app.use(json());
  app.use("/", createSigninRouter({ personRepo, ...(enabled === undefined ? {} : { enabled }) }));
  return app;
}

// scrypt hashing is the slowest thing in this file; hash the one password
// the happy paths need a single time.
let hash: string;
beforeEach(async () => {
  hash ??= await hashPassword(PASSWORD);
});

describe("POST /signin — request shape", () => {
  it.each([
    ["missing email", {}],
    ["blank email", { email: "   ", password: PASSWORD }],
    ["email with no @", { email: "ada.example.com", password: PASSWORD }],
    ["email with no dot in the domain", { email: "ada@example", password: PASSWORD }],
    ["email with whitespace", { email: "a b@example.com", password: PASSWORD }],
  ])("400s on %s", async (_label, body) => {
    const repo = makePersonRepo();
    const res = await request(makeApp(repo)).post("/signin").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_email");
    expect(repo.findByEmail).not.toHaveBeenCalled();
  });

  it("400s when the password is missing", async () => {
    const repo = makePersonRepo();
    const res = await request(makeApp(repo)).post("/signin").send({ email: "ada@example.com" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_password");
    expect(repo.findByEmail).not.toHaveBeenCalled();
  });

  it("400s on a non-string password rather than coercing it", async () => {
    const repo = makePersonRepo();
    const res = await request(makeApp(repo))
      .post("/signin")
      .send({ email: "ada@example.com", password: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_password");
  });

  it("lowercases and trims the email before lookup", async () => {
    const repo = makePersonRepo();
    vi.mocked(repo.findByEmail).mockResolvedValue(undefined);

    await request(makeApp(repo))
      .post("/signin")
      .send({ email: "  ADA@Example.COM  ", password: PASSWORD });

    expect(repo.findByEmail).toHaveBeenCalledWith("ada@example.com");
  });
});

describe("POST /signin — credentials", () => {
  it("returns the caller's existing key on a match", async () => {
    const repo = makePersonRepo();
    vi.mocked(repo.findByEmail).mockResolvedValue(fakePerson({ password_hash: hash }));

    const res = await request(makeApp(repo))
      .post("/signin")
      .send({ email: "ada@example.com", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      api_key: "bv_u_secret",
      person: { id: "person_1", name: "Ada", email: "ada@example.com" },
    });
  });

  it("reports a null email rather than omitting the field", async () => {
    const repo = makePersonRepo();
    const person = fakePerson({ password_hash: hash });
    delete person.email;
    vi.mocked(repo.findByEmail).mockResolvedValue(person);

    const res = await request(makeApp(repo))
      .post("/signin")
      .send({ email: "ada@example.com", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.person.email).toBeNull();
  });

  it("401s on a wrong password", async () => {
    const repo = makePersonRepo();
    vi.mocked(repo.findByEmail).mockResolvedValue(fakePerson({ password_hash: hash }));

    const res = await request(makeApp(repo))
      .post("/signin")
      .send({ email: "ada@example.com", password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
    expect(res.body.api_key).toBeUndefined();
  });

  it("409s a legacy account that has a key but no password", async () => {
    const repo = makePersonRepo();
    vi.mocked(repo.findByEmail).mockResolvedValue(fakePerson());

    const res = await request(makeApp(repo))
      .post("/signin")
      .send({ email: "ada@example.com", password: PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(SIGNIN_NO_PASSWORD_SET);
    expect(res.body.api_key).toBeUndefined();
  });

  it("gives an unknown email and a wrong password the identical 401 body", async () => {
    // The three failure modes must be indistinguishable, otherwise the
    // endpoint tells an attacker which emails have accounts.
    const unknown = makePersonRepo();
    vi.mocked(unknown.findByEmail).mockResolvedValue(undefined);
    const wrongPwd = makePersonRepo();
    vi.mocked(wrongPwd.findByEmail).mockResolvedValue(fakePerson({ password_hash: hash }));

    const unknownRes = await request(makeApp(unknown))
      .post("/signin")
      .send({ email: "nobody@example.com", password: PASSWORD });
    const wrongRes = await request(makeApp(wrongPwd))
      .post("/signin")
      .send({ email: "ada@example.com", password: "nope-nope-nope" });

    expect(unknownRes.status).toBe(wrongRes.status);
    expect(unknownRes.body).toEqual(wrongRes.body);
  });

  it("401s a person row with a password but no api_key", async () => {
    const repo = makePersonRepo();
    const person = fakePerson({ password_hash: hash });
    delete person.api_key;
    vi.mocked(repo.findByEmail).mockResolvedValue(person);

    const res = await request(makeApp(repo))
      .post("/signin")
      .send({ email: "ada@example.com", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
  });
});

describe("POST /signin — lockdown and failures", () => {
  it("404s when the route is disabled", async () => {
    const repo = makePersonRepo();
    const res = await request(makeApp(repo, false))
      .post("/signin")
      .send({ email: "ada@example.com", password: PASSWORD });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("signin_disabled");
    expect(repo.findByEmail).not.toHaveBeenCalled();
  });

  it("is enabled when the flag is omitted", async () => {
    const repo = makePersonRepo();
    vi.mocked(repo.findByEmail).mockResolvedValue(undefined);

    const res = await request(makeApp(repo))
      .post("/signin")
      .send({ email: "ada@example.com", password: PASSWORD });

    expect(res.status).toBe(401);
  });

  it("500s when the lookup throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const repo = makePersonRepo();
    vi.mocked(repo.findByEmail).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(repo))
      .post("/signin")
      .send({ email: "ada@example.com", password: PASSWORD });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error", message: "pg down" });
  });
});
