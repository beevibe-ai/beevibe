-- Agent templates — named, role-shaped agent configurations.
--
-- When set, the spawn pipeline pulls the template's system_prompt
-- addition (via composeSystemPromptAppend) and merges the template's
-- MCP servers into the workspace's mcp-config.json. The template
-- itself lives in code at packages/core/src/templates/; the agent
-- row only stores the name so the lookup stays under git review.
--
-- NULL means "no template — operator-tuned ad-hoc agent" (the only
-- shape that existed before this column). Existing rows stay NULL
-- and behave exactly as before.
ALTER TABLE agent
  ADD COLUMN agent_template TEXT;
