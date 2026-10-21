/**
 * Beevibe-internal tool abstraction. Decouples tool definitions from the MCP
 * SDK so handlers stay testable as plain functions.
 *
 * Each tool is a closure over its caller context + services — `assembleTools`
 * builds a fresh array per MCP session, so handlers can read `caller.agentId`,
 * `beevibeSid`, etc. directly from scope without async-storage threading.
 *
 * The MCP routes register these via the low-level `Server.setRequestHandler`
 * for `ListToolsRequestSchema` and `CallToolRequestSchema` (matches the old
 * intentcore pattern — `agent-mcp-server.ts:471-505`).
 */
export interface AgentTool {
  name: string;
  description: string;
  /** Raw JSON Schema for the tool's input. Sent verbatim to MCP clients. */
  schema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<AgentToolResult>;
}

export interface AgentToolResult {
  /** Structured response. Stringified for the MCP response's text content. */
  content: Record<string, unknown>;
  /** When true, the MCP response is marked `isError: true`. */
  isError?: boolean;
}

/**
 * JSON Schema for a `proposals` argument — the wire shape of core's
 * `Proposal` ({ title, description, tradeoffs? }).
 *
 * `escalate_to_humans` (mesh.ts) and `add_to_escalation` (hierarchy.ts) both
 * take the same array and each spelled out the same eleven-line `items`
 * block, so the schema the agent is held to could drift from `Proposal`, or
 * between the two tools, without anything failing. Only the human-facing
 * `description` differs, so that is the argument.
 */
export function proposalsSchema(description: string): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        tradeoffs: { type: "string" },
      },
      required: ["title", "description"],
    },
    description,
  };
}

/** JSON Schema for the `open_questions` string array both tools take. */
export function openQuestionsSchema(description: string): Record<string, unknown> {
  return { type: "array", items: { type: "string" }, description };
}
