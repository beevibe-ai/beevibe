-- M4: add human user api_key to the person table.
-- bv_u_<nanoid> tokens issued by provisionUser; MCP server prefix-routes them.
ALTER TABLE person
  ADD COLUMN api_key TEXT UNIQUE;
