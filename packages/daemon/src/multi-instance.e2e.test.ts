/**
 * E2E for the dev-only --config-root feature. Opt-in:
 *
 *   BEEVIBE_E2E_MULTI_INSTANCE=1 pnpm --filter @beevibe/daemon test
 *
 * Same opt-in pattern as packages/sandbox/src/docker.e2e.test.ts.
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { loadConfig } from "./config.js";
import { runSetup } from "./setup.js";
import { skillsCacheDir, syncSkillsCache } from "./skills-cache.js";
import { ApiClient } from "./api-client.js";

const ENABLED = process.env.BEEVIBE_E2E_MULTI_INSTANCE === "1";
const describeOrSkip = ENABLED ? describe : describe.skip;

interface RegistrationCall {
  authorization?: string;
  external_id: string;
  device_name: string;
}

interface StubServer {
  url: string;
  registrations: RegistrationCall[];
  shutdown: () => Promise<void>;
}

async function startStubApi(): Promise<StubServer> {
  const registrations: RegistrationCall[] = [];
  let daemonCounter = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", () => {
      if (!res.headersSent) res.writeHead(400).end();
    });
    req.on("end", () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (req.url === "/runtime/register" && req.method === "POST") {
        registrations.push({
          authorization: req.headers.authorization,
          external_id: body.external_id,
          device_name: body.device_name,
        });
        daemonCounter += 1;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            daemon_id: `dmn_e2e_${daemonCounter}`,
            daemon_token: `bv_d_e2e_${daemonCounter}`,
            runtimes: body.runtimes.map(
              (r: { cli: string }, i: number) => ({ id: `rt_e2e_${daemonCounter}_${i}`, cli: r.cli }),
            ),
          }),
        );
        return;
      }
      if (req.url === "/runtime/skills" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            version: "v1-e2e",
            skills: [
              {
                name: "beevibe-test",
                files: [{ path: "SKILL.md", content: "stub skill body\n" }],
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("stub api did not bind");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    registrations,
    shutdown: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describeOrSkip("multi-instance daemon isolation (e2e)", () => {
  let api: StubServer;
  let rootA: string;
  let rootB: string;

  beforeAll(async () => {
    api = await startStubApi();
  });
  afterAll(async () => {
    await api.shutdown();
  });

  beforeEach(() => {
    rootA = mkdtempSync(join(tmpdir(), "beevibe-mi-A-"));
    rootB = mkdtempSync(join(tmpdir(), "beevibe-mi-B-"));
  });
  afterEach(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it("two setups with different configRoots produce two isolated config.json files", async () => {
    const cfgA = await runSetup({
      apiUrl: api.url,
      userToken: "bv_u_account_A",
      configRoot: rootA,
      detectedClis: [{ cli: "claude", cli_version: "1.0.0" }],
    });
    const cfgB = await runSetup({
      apiUrl: api.url,
      userToken: "bv_u_account_B",
      configRoot: rootB,
      detectedClis: [{ cli: "claude", cli_version: "1.0.0" }],
    });

    expect(existsSync(join(rootA, "config.json"))).toBe(true);
    expect(existsSync(join(rootB, "config.json"))).toBe(true);

    expect(cfgA.daemon_token).not.toBe(cfgB.daemon_token);
    expect(cfgA.daemon_id).not.toBe(cfgB.daemon_id);

    expect(loadConfig(rootA)?.daemon_token).toBe(cfgA.daemon_token);
    expect(loadConfig(rootB)?.daemon_token).toBe(cfgB.daemon_token);

    // On-disk: each root's JSON references only its own token — the
    // cross-contamination bug being prevented.
    const rawA = readFileSync(join(rootA, "config.json"), "utf8");
    const rawB = readFileSync(join(rootB, "config.json"), "utf8");
    expect(rawA).toContain(cfgA.daemon_token);
    expect(rawA).not.toContain(cfgB.daemon_token);
    expect(rawB).toContain(cfgB.daemon_token);
    expect(rawB).not.toContain(cfgA.daemon_token);

    expect(api.registrations).toHaveLength(2);
    expect(api.registrations[0]?.authorization).toBe("Bearer bv_u_account_A");
    expect(api.registrations[1]?.authorization).toBe("Bearer bv_u_account_B");
  });

  it("skills cache is namespaced per configRoot — no cross-write race", async () => {
    const apiClient = new ApiClient({ apiUrl: api.url, daemonToken: "bv_d_test" });
    const dirA = await syncSkillsCache(apiClient, rootA);
    const dirB = await syncSkillsCache(apiClient, rootB);

    expect(dirA).toBe(skillsCacheDir(rootA));
    expect(dirB).toBe(skillsCacheDir(rootB));
    expect(dirA).not.toBe(dirB);
    expect(existsSync(join(dirA, ".version"))).toBe(true);
    expect(existsSync(join(dirB, ".version"))).toBe(true);
    expect(existsSync(join(dirA, "beevibe-test", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dirB, "beevibe-test", "SKILL.md"))).toBe(true);
  });
});
