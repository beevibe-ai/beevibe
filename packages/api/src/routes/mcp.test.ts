/**
 * Integration test for the /mcp router. Spins up a real api server (with
 * memory tools wired) and uses the official MCP client to exercise the full
 * protocol path:
 *
 *   1. bv_a_ caller → initialize returns empty `instructions` (briefing
 *      already in --append-system-prompt) and assigns Mcp-Session-Id
 *   2. bv_u_ caller → initialize creates a chat session row + caches the
 *      mcpSid → beevibeSid mapping; instructions includes the briefing
 *   3. tools/list returns save_memory + update_core_memory
 *   4. tools/call save_memory writes to memory_fact, stamped with the
 *      correct beevibe sid in source_session_ids
 *   5. DELETE /mcp triggers session row succeeded + onTaskComplete (cache
 *      onEvict) for human callers
 *
 * Real Postgres (DATABASE_URL_TEST). Real OpenAI embeddings (cheap nano
 * model). LLM-related promotion paths are tested elsewhere; here we just
 * verify the wiring.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresMemoryFactRepository,
  PostgresPersonRepository,
  PostgresSessionRepository,
  type Pool,
} from "@beevibe/core/adapters/postgres";
import { provisionAgent, provisionUser } from "@beevibe/core/auth";
import { DEFAULT_RUNTIME_CONFIG, agentId, personId, sessionId } from "@beevibe/core";
import { createTestPool, truncateAll } from "@beevibe/core/test-helpers";
import { bootstrap, type BootstrapResult } from "../bootstrap.js";

const HAS_LIVE_API_KEYS =
  Boolean(process.env.OPENAI_API_KEY) && Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!HAS_LIVE_API_KEYS)("/mcp router — integration", () => {
  let pool: Pool;
  let agentRepo: PostgresAgentRepository;
  let personRepo: PostgresPersonRepository;
  let coreMemoryRepo: PostgresCoreMemoryRepository;
  let factRepo: PostgresMemoryFactRepository;
  let sessionRepo: PostgresSessionRepository;
  let api: BootstrapResult;
  const port = 3987;

  beforeAll(async () => {
    pool = createTestPool();
    agentRepo = new PostgresAgentRepository(pool);
    personRepo = new PostgresPersonRepository(pool);
    coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
    factRepo = new PostgresMemoryFactRepository(pool);
    sessionRepo = new PostgresSessionRepository(pool);

    api = await bootstrap({
      databaseUrl: process.env.DATABASE_URL_TEST!,
      mcpServerUrl: `http://localhost:${port}/mcp`,
      openaiApiKey: process.env.OPENAI_API_KEY!,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
      port,
    });
    await api.server.start();
  }, 30_000);

  beforeEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await api?.shutdown();
    await pool?.end();
  });

  async function setupAlice() {
    const alice = await provisionUser(
      { personRepo },
      { id: personId(), name: "Alice", email: "alice@example.com" },
    );
    const team = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Alice's Team Agent",
        owner_id: alice.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    return { alice, team };
  }

  async function connectClient(opts: {
    bearerToken: string;
    extraHeaders?: Record<string, string>;
  }): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.bearerToken}`,
      ...opts.extraHeaders,
    };
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${port}/mcp`),
      { requestInit: { headers } },
    );
    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    return { client, transport };
  }

  it(
    "agent caller (bv_a_): initialize returns empty instructions; tools/list returns memory tools",
    async () => {
      const { team } = await setupAlice();

      // Pre-create a beevibe session row matching X-Beevibe-Session
      // (the executor would do this before spawning the agent CLI).
      const sid = sessionId();
      await sessionRepo.create({
        id: sid,
        agent_id: team.agent.id,
        type: "task",
        status: "running",
        intent: "test",
      });

      const { client, transport } = await connectClient({
        bearerToken: team.apiKey,
        extraHeaders: { "X-Beevibe-Session": sid },
      });

      // Initialize was called inside connect. Inspect server info + tools.
      // Team-tier caller gets 24 tools: 2 memory + 16 hierarchy + 6 mesh.
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        "add_to_escalation",
        "ask",
        "check_work_status",
        "create_subordinate_agent",
        "create_task",
        "create_work_product",
        "escalate_to_humans",
        "find_peers",
        "find_subordinates",
        "find_up",
        "get_agent_profile",
        "get_task",
        "get_work_product",
        "list_work_products",
        "negotiate",
        "report_blocker",
        "respond_ask",
        "respond_negotiate",
        "revise_task",
        "save_memory",
        "search_context",
        "update_core_memory",
        "update_progress",
        "update_work_product",
      ]);

      // Server-info has no/empty instructions for agent callers (briefing is
      // injected via --append-system-prompt by the spawner; not duplicated here).
      const inst = client.getInstructions();
      expect(inst === "" || inst === undefined).toBe(true);

      await transport.close();
    },
    30_000,
  );

  it(
    "human caller (bv_u_): initialize sets Mcp-Session-Id and full instructions; save_memory writes a fact",
    async () => {
      const { alice, team } = await setupAlice();

      const { client, transport } = await connectClient({
        bearerToken: alice.apiKey,
      });

      // Human gets full briefing as instructions. M9.4: core_memory is
      // always emitted (even empty). <archival_memory> only appears when
      // there are facts to surface — fresh agent with no archival writes
      // hasn't built any yet, so just core_memory at this point.
      const inst = client.getInstructions();
      expect(inst).toContain("<core_memory>");

      // Server should have assigned a Mcp-Session-Id (transport tracks it)
      const mcpSid = transport.sessionId;
      expect(mcpSid).toBeTruthy();

      // tools/list — human caller, agent is team-tier → 24 tools.
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("save_memory");
      expect(names).toContain("update_core_memory");
      expect(names).toContain("find_subordinates");
      expect(names).toContain("ask");
      expect(names).toContain("negotiate");
      expect(names).toContain("escalate_to_humans");
      expect(names).toContain("add_to_escalation");
      expect(names).toContain("revise_task");
      expect(names).toContain("create_subordinate_agent");
      expect(names).toContain("get_work_product");
      expect(tools.tools.length).toBe(24);

      // tools/call save_memory — should write a fact stamped with the auto-
      // created beevibe chat session id. We don't know the sid client-side;
      // verify by looking up facts for the agent.
      const result = await client.callTool({
        name: "save_memory",
        arguments: {
          content: "I really love the color green.",
          fact_type: "preference",
        },
      });
      expect(result.isError).toBeFalsy();

      // addOrMerge stamps the fact's scope from the saver's hierarchy_level.
      // The caller here is a team-tier human, so the fact lands at scope='team'.
      // FactPromoter.onTaskComplete can elevate to 'org' later if it recurs.
      const facts = await factRepo.listByAgentScope(team.agent.id, "team");
      expect(facts).toHaveLength(1);
      expect(facts[0]?.content).toContain("green");
      expect(facts[0]?.fact_type).toBe("preference");
      expect(facts[0]?.source_session_ids).toHaveLength(1);

      // The session id stamped on the fact should be the one we cached for
      // this MCP session.
      const cachedBeevibeSid = api.sessionCache.get(mcpSid!);
      expect(cachedBeevibeSid).toBe(facts[0]?.source_session_ids[0]);

      await transport.close();
    },
    60_000,
  );

  it(
    "agent caller without X-Beevibe-Session is rejected at initialize",
    async () => {
      const { team } = await setupAlice();

      const transport = new StreamableHTTPClientTransport(
        new URL(`http://localhost:${port}/mcp`),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${team.apiKey}` },
          },
        },
      );
      const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { capabilities: {} },
      );

      // The connect call should fail because initialize gets a 400 from
      // our handler (agent_caller_missing_x_beevibe_session).
      await expect(client.connect(transport)).rejects.toThrow();
    },
    15_000,
  );

  it("missing Authorization header → 401 at initialize", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${port}/mcp`),
    );
    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
