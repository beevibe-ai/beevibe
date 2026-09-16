/**
 * `/mcp` router — hermetic tests over the real MCP protocol.
 *
 * `mcp.test.ts` next door covers the same router end-to-end, but it needs
 * a live Postgres *and* live OpenAI + Anthropic keys, so it is skipped in
 * any checkout without them. That left the product's primary agent-facing
 * surface — session lifecycle, caller gating, per-caller tool assembly —
 * with no coverage outside a fully provisioned environment.
 *
 * These tests fake the dependency graph (`assembleTools` only *constructs*
 * tool closures, so repos are never touched at assembly time) and drive a
 * real `Client` over a real `StreamableHTTPClientTransport`, so the SDK's
 * initialize / tools-list / tools-call / DELETE handshake is exercised for
 * real. No network beyond loopback, no DB, no provider keys.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import express, { json, type RequestHandler } from "express";
import type { Server } from "node:http";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import { createMcpRouter, type McpRouterDeps } from "./mcp.js";

const AGENT_ID = "agt_test";
const PERSON_ID = "per_test";
const BOUND_SID = "ses_bound";

const agentCaller: ResolvedCaller = {
  source: "agent",
  agentId: AGENT_ID,
  hierarchyLevel: "team",
};
const humanCaller: ResolvedCaller = {
  source: "human",
  agentId: AGENT_ID,
  personId: PERSON_ID,
  hierarchyLevel: "team",
} as ResolvedCaller;
const daemonCaller = { source: "daemon", daemonId: "dmn_1" } as unknown as ResolvedCaller;

interface Harness {
  deps: McpRouterDeps;
  sessionCreate: ReturnType<typeof vi.fn>;
  sessionFindById: ReturnType<typeof vi.fn>;
  cacheSet: ReturnType<typeof vi.fn>;
  cacheDelete: ReturnType<typeof vi.fn>;
  personFindById: ReturnType<typeof vi.fn>;
  saveMemory: ReturnType<typeof vi.fn>;
  /** Swap the caller the fake auth middleware attaches. */
  setCaller(caller: ResolvedCaller | undefined): void;
}

/**
 * Build the router's dependency graph out of fakes. Only the handful of
 * methods the router itself calls do anything; the rest exist so tool
 * construction can close over them.
 */
function makeHarness(): Harness {
  let caller: ResolvedCaller | undefined = agentCaller;

  const sessionCreate = vi.fn(async () => undefined);
  const sessionFindById = vi.fn(async () => ({ id: BOUND_SID, spawn_mode: undefined }));
  const cacheSet = vi.fn();
  const cacheDelete = vi.fn(async () => undefined);
  const personFindById = vi.fn(async () => ({
    id: PERSON_ID,
    capability_network_enabled: true,
  }));
  const saveMemory = vi.fn(async () => ({ id: "fct_1" }));

  const authMiddleware: RequestHandler = (req, _res, next) => {
    req.caller = caller;
    next();
  };

  const memoryAgent = {
    prepareCoreOnly: async () => ({
      systemPromptAppend: "<core_memory>fake blocks</core_memory>",
      userPromptPrefix: "",
    }),
  } as unknown as MemoryAgent;

  const deps = {
    authMiddleware,
    factStore: { addOrMerge: saveMemory },
    coreMemory: { read: async () => [], upsert: async () => undefined },
    coreMemoryRepo: {},
    agentProvisionEventRepo: {},
    sessionCache: { set: cacheSet, delete: cacheDelete, get: () => undefined },
    sessionRepo: { create: sessionCreate, findById: sessionFindById },
    agentRepo: {
      findById: async () => ({
        id: AGENT_ID,
        name: "Test Team Agent",
        owner_id: PERSON_ID,
        hierarchy_level: "team",
        runtime_config: {},
      }),
      findSubordinates: async () => [],
    },
    taskRepo: {},
    workProductRepo: {},
    taskService: {},
    escalationService: {},
    dispatchService: {},
    mesh: {},
    pool: {},
    makeMemoryAgent: () => memoryAgent,
    repoRunRepo: {},
    learnedSkillRepo: {},
    embeddings: {},
    personRepo: { findById: personFindById },
    watchService: {},
    sessionSearch: {},
  } as unknown as McpRouterDeps;

  return {
    deps,
    sessionCreate,
    sessionFindById,
    cacheSet,
    cacheDelete,
    personFindById,
    saveMemory,
    setCaller(next) {
      caller = next;
    },
  };
}

function makeApp(deps: McpRouterDeps): express.Express {
  const app = express();
  app.use(json());
  app.use("/mcp", createMcpRouter(deps));
  return app;
}

const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
};

let harness: Harness;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  harness = makeHarness();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("/mcp — POST gating", () => {
  it("rejects a non-initialize POST that carries no session id", async () => {
    const res = await request(makeApp(harness.deps))
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_or_invalid_session_id");
  });

  it("rejects a POST whose session id is unknown to this process", async () => {
    const res = await request(makeApp(harness.deps))
      .post("/mcp")
      .set("mcp-session-id", "never-issued")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_or_invalid_session_id");
  });

  it("401s defensively when auth let a request through with no caller", async () => {
    harness.setCaller(undefined);

    const res = await request(makeApp(harness.deps)).post("/mcp").send(INITIALIZE_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthenticated");
  });

  it("403s a daemon token and points it at /runtime/*", async () => {
    harness.setCaller(daemonCaller);

    const res = await request(makeApp(harness.deps)).post("/mcp").send(INITIALIZE_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("daemon_not_allowed");
    expect(res.body.message).toContain("/runtime/*");
  });

  it("400s an agent caller that binds no beevibe session", async () => {
    harness.setCaller(agentCaller);

    const res = await request(makeApp(harness.deps)).post("/mcp").send(INITIALIZE_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("agent_caller_missing_x_beevibe_session");
    expect(res.body.message).toContain("X-Beevibe-Session");
    // Nothing should have been minted for a rejected caller.
    expect(harness.sessionCreate).not.toHaveBeenCalled();
  });

  it("treats an empty X-Beevibe-Session as absent", async () => {
    harness.setCaller(agentCaller);

    const res = await request(makeApp(harness.deps))
      .post("/mcp")
      .set("X-Beevibe-Session", "")
      .send(INITIALIZE_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("agent_caller_missing_x_beevibe_session");
  });

  it("returns 500 rather than leaking a handler throw", async () => {
    harness.deps.makeMemoryAgent = () => {
      throw new Error("memory agent exploded");
    };
    harness.setCaller(agentCaller);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await request(makeApp(harness.deps))
      .post("/mcp")
      .set("X-Beevibe-Session", BOUND_SID)
      .send(INITIALIZE_BODY);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    errSpy.mockRestore();
  });
});

describe("/mcp — GET and DELETE gating", () => {
  it("400s a GET with no session id", async () => {
    const res = await request(makeApp(harness.deps)).get("/mcp");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_valid_session_id");
  });

  it("400s a GET whose session id was never issued", async () => {
    const res = await request(makeApp(harness.deps))
      .get("/mcp")
      .set("mcp-session-id", "never-issued");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_valid_session_id");
  });

  it("400s a DELETE with no session id", async () => {
    const res = await request(makeApp(harness.deps)).delete("/mcp");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_session_id");
  });

  it("treats DELETE of an unknown session as already-gone", async () => {
    const res = await request(makeApp(harness.deps))
      .delete("/mcp")
      .set("mcp-session-id", "never-issued");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(harness.cacheDelete).not.toHaveBeenCalled();
  });
});

describe("/mcp — protocol round trips", () => {
  let server: Server;
  let baseUrl: URL;
  const open: Array<{ close: () => Promise<void> }> = [];

  beforeEach(async () => {
    server = makeApp(harness.deps).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  });

  afterEach(async () => {
    while (open.length > 0) {
      await open
        .pop()
        ?.close()
        .catch(() => undefined);
    }
    await new Promise((resolve) => server.close(resolve));
  });

  async function connect(
    extraHeaders: Record<string, string> = {},
  ): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const transport = new StreamableHTTPClientTransport(baseUrl, {
      requestInit: { headers: extraHeaders },
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
    open.push(transport);
    return { client, transport };
  }

  it("binds an agent caller to the session from the header, minting no row", async () => {
    harness.setCaller(agentCaller);

    const { client, transport } = await connect({ "X-Beevibe-Session": BOUND_SID });

    expect(transport.sessionId).toBeTruthy();
    // The executor already created the row before spawning the CLI.
    expect(harness.sessionCreate).not.toHaveBeenCalled();
    expect(harness.sessionFindById).toHaveBeenCalledWith(BOUND_SID);
    // Briefing already rode in on --append-system-prompt; not duplicated.
    expect(client.getInstructions() ?? "").toBe("");
    // Agent callers pass the sid explicitly, so nothing to cache.
    expect(harness.cacheSet).not.toHaveBeenCalled();
  });

  it("accepts the beevibe_session query param for runtimes that can't set headers", async () => {
    harness.setCaller(agentCaller);
    const withQuery = new URL(baseUrl);
    withQuery.searchParams.set("beevibe_session", "ses_from_query");
    const transport = new StreamableHTTPClientTransport(withQuery);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });

    await client.connect(transport);
    open.push(transport);

    expect(harness.sessionFindById).toHaveBeenCalledWith("ses_from_query");
    expect(harness.sessionCreate).not.toHaveBeenCalled();
  });

  it("mints a chat session row and caches the mapping for a human caller", async () => {
    harness.setCaller(humanCaller);

    const { client, transport } = await connect();

    expect(harness.sessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: AGENT_ID,
        type: "chat",
        status: "running",
        intent: "(interactive)",
      }),
    );
    const mintedSid = harness.sessionCreate.mock.calls[0]?.[0].id;
    expect(harness.cacheSet).toHaveBeenCalledWith(transport.sessionId, mintedSid);
    // Humans drive a local CLI that has no briefing of its own.
    expect(client.getInstructions()).toContain("<core_memory>");
  });

  it("serves tools/list over the assembled per-caller surface", async () => {
    harness.setCaller(agentCaller);
    const { client } = await connect({ "X-Beevibe-Session": BOUND_SID });

    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).toEqual(expect.arrayContaining(["save_memory", "search_context"]));
    // Every advertised tool carries the schema the SDK requires.
    for (const tool of (await client.listTools()).tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.description).toBe("string");
    }
  });

  it("routes tools/call to the matching handler and JSON-encodes the result", async () => {
    harness.setCaller(agentCaller);
    harness.saveMemory.mockResolvedValue({ id: "fct_42" });
    const { client } = await connect({ "X-Beevibe-Session": BOUND_SID });

    const result = (await client.callTool({
      name: "save_memory",
      arguments: { content: "I like green.", fact_type: "preference" },
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBeFalsy();
    expect(harness.saveMemory).toHaveBeenCalled();
    // The handler's payload is stringified into a single text block.
    expect(() => JSON.parse(result.content[0]!.text)).not.toThrow();
  });

  it("raises MethodNotFound for a tool that isn't on this caller's surface", async () => {
    harness.setCaller(agentCaller);
    const { client } = await connect({ "X-Beevibe-Session": BOUND_SID });

    await expect(client.callTool({ name: "no_such_tool", arguments: {} })).rejects.toThrow(
      /Unknown tool: no_such_tool/,
    );
  });

  it("converts a throwing tool handler into an isError result, not a transport fault", async () => {
    harness.setCaller(agentCaller);
    harness.saveMemory.mockRejectedValue(new Error("fact store offline"));
    const { client } = await connect({ "X-Beevibe-Session": BOUND_SID });

    const result = (await client.callTool({
      name: "save_memory",
      arguments: { content: "anything", fact_type: "preference" },
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: "fact store offline" });
    // The session must survive a tool failure.
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });
});

describe("/mcp — capability network gating", () => {
  let server: Server;
  let baseUrl: URL;
  const open: Array<{ close: () => Promise<void> }> = [];

  beforeEach(async () => {
    server = makeApp(harness.deps).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  });

  afterEach(async () => {
    while (open.length > 0) {
      await open
        .pop()
        ?.close()
        .catch(() => undefined);
    }
    await new Promise((resolve) => server.close(resolve));
  });

  async function toolNames(): Promise<string[]> {
    const transport = new StreamableHTTPClientTransport(baseUrl, {
      requestInit: { headers: { "X-Beevibe-Session": BOUND_SID } },
    });
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    open.push(transport);
    return (await client.listTools()).tools.map((t) => t.name);
  }

  it("strips find_repo/use_repo when the owner has the network turned off", async () => {
    harness.setCaller(agentCaller);
    harness.personFindById.mockResolvedValue({
      id: PERSON_ID,
      capability_network_enabled: false,
    });

    const names = await toolNames();

    expect(names).not.toContain("find_repo");
    expect(names).not.toContain("use_repo");
  });

  it("keeps them when the owner has it on", async () => {
    harness.setCaller(agentCaller);

    const names = await toolNames();

    expect(names).toEqual(expect.arrayContaining(["find_repo", "use_repo"]));
  });

  it("defaults the network ON when the owner lookup fails", async () => {
    harness.setCaller(agentCaller);
    harness.personFindById.mockRejectedValue(new Error("db blip"));

    const names = await toolNames();

    // A transient DB blip must not lock the feature out for everyone.
    expect(names).toEqual(expect.arrayContaining(["find_repo", "use_repo"]));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to read owner preferences"),
      expect.anything(),
    );
  });

  it("resolves a human caller's preference from their own person row", async () => {
    harness.setCaller(humanCaller);
    harness.personFindById.mockResolvedValue({
      id: PERSON_ID,
      capability_network_enabled: false,
    });

    const transport = new StreamableHTTPClientTransport(baseUrl);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    open.push(transport);

    // No agentRepo hop needed — the human *is* the owner.
    expect(harness.personFindById).toHaveBeenCalledWith(PERSON_ID);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("use_repo");
  });

  it("falls back to the full surface when the bound session can't be loaded", async () => {
    harness.setCaller(agentCaller);
    harness.sessionFindById.mockRejectedValue(new Error("db blip"));

    const names = await toolNames();

    expect(names).toContain("save_memory");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`failed to load session ${BOUND_SID}`),
      expect.anything(),
    );
  });

  it("restricts the surface for a server-fallback-mesh spawn", async () => {
    harness.setCaller(agentCaller);
    harness.sessionFindById.mockResolvedValue({
      id: BOUND_SID,
      spawn_mode: "server_fallback_mesh",
    });

    const names = await toolNames();

    // Fallback callers answer the ask; they don't carry on building.
    expect(names).not.toContain("create_task");
    expect(names).not.toContain("create_subordinate_agent");
    expect(names).toContain("search_context");
  });
});

describe("/mcp — session teardown", () => {
  let server: Server;
  let baseUrl: URL;

  beforeEach(async () => {
    server = makeApp(harness.deps).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  });

  afterEach(async () => {
    while (open.length > 0) {
      // close() tears down the client stream without sending DELETE, so
      // the teardown assertions stay the only DELETE in each test.
      await open
        .pop()
        ?.close()
        .catch(() => undefined);
    }
    await new Promise((resolve) => server.close(resolve));
  });

  const open: Array<{ close: () => Promise<void> }> = [];

  async function initialize(headers: Record<string, string>): Promise<string> {
    const transport = new StreamableHTTPClientTransport(baseUrl, {
      requestInit: { headers },
    });
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    open.push(transport);
    return transport.sessionId!;
  }

  it("evicts a human session from the cache on DELETE", async () => {
    harness.setCaller(humanCaller);
    const sid = await initialize({});
    harness.cacheDelete.mockClear();

    await request(`${baseUrl.origin}`).delete("/mcp").set("mcp-session-id", sid);

    expect(harness.cacheDelete).toHaveBeenCalledWith(sid);
  });

  it("leaves an agent-spawned session's cache entry alone on DELETE", async () => {
    harness.setCaller(agentCaller);
    const sid = await initialize({ "X-Beevibe-Session": BOUND_SID });
    harness.cacheDelete.mockClear();

    await request(`${baseUrl.origin}`).delete("/mcp").set("mcp-session-id", sid);

    // The spawner owns that session's lifecycle, not the transport.
    expect(harness.cacheDelete).not.toHaveBeenCalled();
  });

  it("forgets the session so a later request with the same id is rejected", async () => {
    harness.setCaller(agentCaller);
    const sid = await initialize({ "X-Beevibe-Session": BOUND_SID });

    await request(`${baseUrl.origin}`).delete("/mcp").set("mcp-session-id", sid);
    const after = await request(`${baseUrl.origin}`).get("/mcp").set("mcp-session-id", sid);

    expect(after.status).toBe(400);
    expect(after.body.error).toBe("no_valid_session_id");
  });
});
