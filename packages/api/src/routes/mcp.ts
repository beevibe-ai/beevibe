import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type RequestHandler } from "express";
import { Server as McpLowLevelServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpCaller } from "../tools/assemble.js";
import type { CoreMemory, FactStore, MemoryAgent } from "@beevibe/core/services/memory";
import type {
  AgentProvisionEventRepository,
  AgentRepository,
  CoreMemoryBlockRepository,
  SessionRepository,
  TaskRepository,
  WorkProductRepository,
} from "@beevibe/core";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { sessionId as makeBeevibeSid } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { MeshServer } from "../mesh/server.js";
import { assembleTools } from "../tools/assemble.js";
import { buildInstructions } from "../tools/instructions.js";
import type { AgentTool } from "../tools/types.js";
import type { SessionCache } from "../session-cache.js";

export interface McpRouterDeps {
  authMiddleware: RequestHandler;
  factStore: FactStore;
  coreMemory: CoreMemory;
  /** Phase 9: backs `create_subordinate_agent` (seeds persona/domain blocks). */
  coreMemoryRepo: CoreMemoryBlockRepository;
  /** Phase 9: audit + per-parent daily cap on subordinate spawning. */
  agentProvisionEventRepo: AgentProvisionEventRepository;
  sessionCache: SessionCache;
  sessionRepo: SessionRepository;
  agentRepo: AgentRepository;
  taskRepo: TaskRepository;
  workProductRepo: WorkProductRepository;
  taskService: TaskService;
  escalationService: EscalationService;
  dispatchService: DispatchService;
  mesh: MeshServer;
  pool: Pool;
  makeMemoryAgent: (agentId: string) => MemoryAgent;
}

/** Tracked per-MCP-session state. mcpSid ↔ transport + server. */
interface ActiveMcpSession {
  transport: StreamableHTTPServerTransport;
  server: McpLowLevelServer;
  caller: McpCaller;
  beevibeSid: string;
  createdAt: number;
}

/**
 * Construct the `/mcp` HTTP router with full session lifecycle management.
 *
 * Pattern lifted from intentcore's `agent-mcp-server.ts:378-466`, with these
 * adaptations for beevibe:
 *   - No OAuth bridge (Bearer auth via M4's `lookupApiKey` only).
 *   - Per-session beevibe sid: agents pass `X-Beevibe-Session` header (set
 *     before they were spawned). Runtimes that cannot set custom MCP headers
 *     may pass `?beevibe_session=...` on the MCP URL instead. Humans get a
 *     fresh chat session row + sid created at initialize, with the cache
 *     mapping `mcpSid → beevibeSid`.
 *   - Tools are assembled fresh per session via `assembleTools(ctx, services)`,
 *     closed over the resolved caller + sid (no async-storage threading).
 *
 * Multiple concurrent sessions OK: each gets its own transport instance and
 * MCP server, keyed by mcpSid in the active-sessions map.
 */
export function createMcpRouter(deps: McpRouterDeps): Router {
  const router = Router();
  const sessions = new Map<string, ActiveMcpSession>();

  // Auth on every request to /mcp/*
  router.use(deps.authMiddleware);

  router.post("/", async (req, res) => {
    try {
      await handleMcpRequest(req, res, sessions, deps);
    } catch (err) {
      console.error("[mcp] request error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error" });
      }
    }
  });

  // GET /mcp — used by the SDK for SSE streams on already-initialized sessions
  router.get("/", async (req, res) => {
    const mcpSid = req.headers["mcp-session-id"];
    if (typeof mcpSid !== "string" || !sessions.has(mcpSid)) {
      res.status(400).json({ error: "no_valid_session_id" });
      return;
    }
    try {
      await sessions.get(mcpSid)!.transport.handleRequest(req, res);
    } catch (err) {
      console.error("[mcp] GET error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error" });
      }
    }
  });

  // DELETE /mcp — explicit session termination
  router.delete("/", async (req, res) => {
    const mcpSid = req.headers["mcp-session-id"];
    if (typeof mcpSid !== "string") {
      res.status(400).json({ error: "no_session_id" });
      return;
    }
    const session = sessions.get(mcpSid);
    if (!session) {
      res.status(200).json({ ok: true });
      return;
    }

    // For human callers, evict from cache (fires sessionRepo.update + onEvict
    // hook which the bootstrap wires to memoryAgent.onTaskComplete for fact
    // promotion). Agent-spawned sessions are owned by the spawner — DELETE is
    // a clean shutdown of the MCP transport only.
    if (session.caller.source === "human") {
      await deps.sessionCache.delete(mcpSid);
    }

    try {
      // Let the SDK send the appropriate response per spec.
      await session.transport.handleRequest(req, res);
    } catch (err) {
      console.error("[mcp] DELETE error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error" });
      }
    }
    sessions.delete(mcpSid);
  });

  return router;
}

async function handleMcpRequest(
  req: Request,
  res: Response,
  sessions: Map<string, ActiveMcpSession>,
  deps: McpRouterDeps,
): Promise<void> {
  const mcpSid = req.headers["mcp-session-id"];

  // Existing session — route through its transport
  if (typeof mcpSid === "string" && sessions.has(mcpSid)) {
    await sessions.get(mcpSid)!.transport.handleRequest(req, res, req.body);
    return;
  }

  // New session: must be an `initialize` request
  if (!isInitializeRequest(req.body)) {
    res.status(400).json({ error: "missing_or_invalid_session_id" });
    return;
  }

  const caller = req.caller;
  if (!caller) {
    // Auth middleware should have handled this; defensive.
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (caller.source === "daemon") {
    // Daemons authenticate to /runtime/* only — they spawn the CLI which
    // calls /mcp with its own bv_a_ token.
    res.status(403).json({
      error: "daemon_not_allowed",
      message: "/mcp is for bv_a_ and bv_u_ callers; use /runtime/* for daemons",
    });
    return;
  }

  // Resolve the beevibe session id this MCP session is bound to.
  let beevibeSid: string;
  if (caller.source === "agent") {
    const fromHeader = req.headers["x-beevibe-session"];
    const fromQuery = req.query.beevibe_session;
    const sid =
      typeof fromHeader === "string" && fromHeader
        ? fromHeader
        : typeof fromQuery === "string" && fromQuery
          ? fromQuery
          : undefined;
    if (!sid) {
      res.status(400).json({
        error: "agent_caller_missing_x_beevibe_session",
        message:
          "Agent callers must pass the X-Beevibe-Session header or " +
          "?beevibe_session=... on the MCP URL.",
      });
      return;
    }
    beevibeSid = sid;
  } else {
    // Human: mint a fresh chat session row.
    beevibeSid = makeBeevibeSid();
    await deps.sessionRepo.create({
      id: beevibeSid,
      agent_id: caller.agentId,
      type: "chat",
      status: "running",
      intent: "(interactive)",
    });
  }

  // Build instructions + tools for this caller. Each MCP session gets its own
  // MemoryAgent (closed over caller.agentId) so search_context queries hit
  // the right agent's archival memory.
  const memoryAgent = deps.makeMemoryAgent(caller.agentId);
  const instructions = await buildInstructions(caller, memoryAgent, deps.agentRepo);
  // Look up the bound beevibe session so we can branch the tool surface for
  // server-fallback-mesh spawns (restricted set; see assembleTools). Failure
  // to load is non-fatal — we default to the full surface and the caller
  // (the agent) wouldn't be able to hit a row it doesn't own anyway.
  let spawnMode: import("@beevibe/core").SessionSpawnMode | undefined;
  try {
    const sess = await deps.sessionRepo.findById(beevibeSid);
    spawnMode = sess?.spawn_mode;
  } catch (err) {
    console.warn(`[mcp] failed to load session ${beevibeSid} for spawn_mode:`, err);
  }
  const tools = assembleTools(
    { caller, beevibeSid, spawnMode },
    {
      factStore: deps.factStore,
      coreMemory: deps.coreMemory,
      coreMemoryRepo: deps.coreMemoryRepo,
      agentProvisionEventRepo: deps.agentProvisionEventRepo,
      agentRepo: deps.agentRepo,
      taskRepo: deps.taskRepo,
      workProductRepo: deps.workProductRepo,
      taskService: deps.taskService,
      escalationService: deps.escalationService,
      dispatchService: deps.dispatchService,
      mesh: deps.mesh,
      pool: deps.pool,
      memoryAgent,
    },
  );

  const server = new McpLowLevelServer(
    { name: "beevibe", version: "0.0.1" },
    { capabilities: { tools: {} }, instructions },
  );
  registerToolsOnServer(server, tools);

  let assignedSid: string | undefined;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid: string) => {
      assignedSid = sid;
      sessions.set(sid, {
        transport,
        server,
        caller,
        beevibeSid,
        createdAt: Date.now(),
      });
      // For human callers, cache the mcpSid → beevibeSid mapping. Agent
      // callers don't need cache lookup (they pass X-Beevibe-Session
      // explicitly on every request).
      if (caller.source === "human") {
        deps.sessionCache.set(sid, beevibeSid);
      }
    },
  });

  transport.onclose = () => {
    if (assignedSid) {
      sessions.delete(assignedSid);
    }
  };

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/**
 * Wire AgentTool array onto a low-level MCP `Server` via the SDK's request
 * handlers for tools/list and tools/call. Mirrors intentcore's
 * `agent-mcp-server.ts:471-503`.
 */
function registerToolsOnServer(server: McpLowLevelServer, tools: AgentTool[]): void {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.schema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try {
      const result = await tool.handler((args ?? {}) as Record<string, unknown>);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result.content, null, 2) },
        ],
        isError: result.isError ?? false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });
}
