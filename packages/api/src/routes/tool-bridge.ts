/**
 * Running an MCP agent tool on behalf of a human caller.
 *
 * `/find-repo` and `/capabilities/use` are both HTTP front doors onto a
 * tool that agents normally call over MCP, and both opened with the same
 * ten lines: resolve the caller's primary team agent, 404 `no_agent` when
 * they have none, build the tool under that agent's identity, run it, and
 * map an `isError` result to a 400. `capabilities.ts` carried a comment
 * saying "Same pattern as /find-repo", which is the kind of note that
 * stops being true quietly — the `no_agent` envelope in particular was
 * duplicated word for word in two places.
 *
 * The outer 500 stays at the call site: each route has its own failure
 * code (`search_failed`, `use_failed`) and its own log tag.
 */
import type { Response } from "express";
import type { AgentRepository } from "@beevibe/core";
import type { HumanRequest } from "../auth/middleware.js";
import type { AgentTool } from "../tools/types.js";

export interface RunToolOptions {
  /** Build the tool once the caller's agent id is known. */
  makeTool: (agentId: string) => AgentTool;
  /** Input passed to the tool's handler. */
  input: Record<string, unknown>;
  /**
   * Status for a successful run. `/find-repo` answers 200 (the ranking is
   * complete); `/capabilities/use` answers 202 (the sandbox run was only
   * just kicked off).
   */
  okStatus: number;
}

/**
 * Resolve the human caller's primary team agent and run `makeTool`'s tool
 * as that agent, responding with the tool's own `content` envelope.
 *
 * Why the caller's *team* agent: the tools scope their reads and the rows
 * they write (container task, repo_run, work_product) to an agent, and the
 * top-level team agent is the one a human owns outright — which matches
 * what the equivalent agent-driven MCP call would produce.
 *
 * Takes a `HumanRequest`, so the call site has to have gone through
 * `requireHuman` first — the human caller's person id is what the agent
 * lookup keys on. Throws nothing of its own; a repository or handler
 * rejection propagates to the caller's `catch`.
 */
export async function runToolAsPrimaryAgent(
  req: HumanRequest,
  res: Response,
  agentRepo: AgentRepository,
  opts: RunToolOptions,
): Promise<void> {
  const agent = await agentRepo.findTopLevelForOwner(req.caller.personId);
  if (!agent) {
    res.status(404).json({ error: "no_agent", message: "Caller has no primary agent." });
    return;
  }

  const result = await opts.makeTool(agent.id).handler(opts.input);
  res.status(result.isError ? 400 : opts.okStatus).json(result.content);
}
