/**
 * Running an MCP agent tool on behalf of a human HTTP caller.
 *
 * Two REST endpoints exist only to give the Capabilities UI the same
 * capability an agent gets over MCP: `/find-repo` wraps the `find_repo`
 * tool's ranker, and `/capabilities/use` wraps `use_repo`. Both had spelled
 * out the same bridge inline — `/capabilities`' copy is even commented
 * "Same pattern as /find-repo".
 *
 * The bridge is four steps, and three of them are contract, not plumbing:
 *
 *   1. Resolve the caller's primary team agent. The tools are written
 *      against an agent identity: `find_repo`'s ranker scopes learned-skill
 *      lookups to the calling agent's owner, and `use_repo`'s container
 *      task / repo_run / work_product rows are owned by the agent that ran
 *      it. Substituting the person id would silently change both.
 *   2. 404 `no_agent` when there is no such agent.
 *   3. Map the tool's own `isError` result to a 400, passing its structured
 *      `content` straight through — that content is the tool's error
 *      envelope and clients read it.
 *   4. Answer with the tool's `content` on success, at the status the
 *      endpoint has already published (200 for a search, 202 for a
 *      kicked-off run).
 */

import type { Response } from "express";
import type { AgentRepository } from "@beevibe/core";
import type { AgentTool } from "../tools/types.js";

export interface RunAsPrimaryAgentOptions {
  res: Response;
  personId: string;
  agentRepo: AgentRepository;
  /** Builds the tool once the agent identity is known. */
  makeTool: (agentId: string) => AgentTool;
  /** Arguments for the tool's handler, already validated by the route. */
  input: Record<string, unknown>;
  /** Status for the success branch — 200 for a read, 202 for a kicked-off run. */
  successStatus: number;
}

/**
 * Resolve the caller's primary team agent, run `makeTool`'s tool under that
 * identity, and answer the request from the tool's own result.
 *
 * Responds in every branch. Throws only what the tool handler throws, so
 * callers keep their existing try/catch and its per-endpoint 500 code.
 */
export async function runToolAsPrimaryAgent(opts: RunAsPrimaryAgentOptions): Promise<void> {
  const agent = await opts.agentRepo.findTopLevelForOwner(opts.personId);
  if (!agent) {
    opts.res.status(404).json({ error: "no_agent", message: "Caller has no primary agent." });
    return;
  }

  const result = await opts.makeTool(agent.id).handler(opts.input);
  opts.res.status(result.isError ? 400 : opts.successStatus).json(result.content);
}
