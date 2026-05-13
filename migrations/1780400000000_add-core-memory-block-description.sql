-- Add `description` field to core memory blocks — first-person guidance
-- the agent reads to decide WHAT belongs in each block. Surface in the
-- <core_memory> system-prompt render + as tool-call guidance for
-- update_core_memory / create_subordinate_agent.
--
-- Per the agent-as-persistent-specialist framing (issue diagnosis), each
-- block has a narrow purpose: identity stays in persona/domain/tag_line;
-- project context goes in active_context; rules in constraints. The
-- description column is the single source of truth for these per-block
-- semantics.
--
-- Also seed `tag_line` block for every existing agent — used by the UI's
-- agent-card "specialization" line and as the agent's enduring headline.

ALTER TABLE core_memory_block
  ADD COLUMN description TEXT NOT NULL DEFAULT '';

-- Backfill descriptions on existing blocks. Hand-coded per (level,
-- block_name) pair so the migration is reproducible without a runtime
-- read of the JS template constant. Keep in lockstep with
-- packages/core/src/domain/core-memory.ts:DEFAULT_BLOCK_TEMPLATES.

UPDATE core_memory_block b
SET description = CASE b.block_name
  WHEN 'persona' THEN
    'Who I am and how I work — my role and working style, persistent across every project I touch. 1-3 sentences in first person. Update when my self-conception genuinely shifts. NOT my current project (that''s `active_context`), NOT my domain scope (that''s `domain`).'
  WHEN 'domain' THEN
    'The areas I specialize in ACROSS all projects — my enduring expertise. As I work on more projects in my domain, this can deepen (becoming truly expert in narrower sub-areas). Bullet format. NOT project-specific paths (those go in `active_context`). NOT the rules I follow (those go in `constraints`).'
  WHEN 'active_context' THEN
    'What I''m currently working on — the specific project and its in-flight details. Bullet format. Transient — rewrite when the project changes. This is where ALL project/codebase-specific details live, NOT in `domain`.'
  WHEN 'constraints' THEN
    'Hard rules I follow — non-negotiable conventions and coordination boundaries. Mix of persistent rules and project-specific rules. Bullet format. Reference docs by path, not content.'
  WHEN 'team_members' THEN
    'Roster of my direct reports — for each: name, agent_id, specialization (NOT project assignment). Bullet format. Update when subordinates are spawned/archived/reassigned.'
  WHEN 'active_work' THEN
    'What my team is currently working on — the active project + high-level work in flight across specialists. Bullet format. Transient — rewrite on project shifts.'
  WHEN 'patterns' THEN
    'Cross-project patterns I''ve observed in how my team operates — what works, what trips them up. Persistent. NOT specific findings about a codebase (those go in archival memory via save_memory).'
  WHEN 'teams' THEN
    'Teams under my oversight — for each: name, team-lead agent_id, scope. Persistent identity. Bullet format.'
  WHEN 'strategy' THEN
    'Cross-project / cross-team direction I''m driving. Higher-level than active_work.'
  WHEN 'decisions' THEN
    'Cross-team decisions I''ve resolved — bullet log. Each entry: what was decided, when, why.'
  ELSE description
END
WHERE description = '';

-- Seed `tag_line` block for every existing agent that doesn't already
-- have one. The content stays empty; the UI's "specialization" line
-- falls back to the agent's persona/domain first-line when tag_line is
-- blank. Agents will fill in tag_line on their next session via
-- update_core_memory guidance.

INSERT INTO core_memory_block (id, agent_id, block_name, content, char_limit, is_system, description)
SELECT
  'blk_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  a.id,
  'tag_line',
  '',
  100,
  TRUE,
  CASE a.hierarchy_level
    WHEN 'ic' THEN 'One-line headline of my enduring specialization — shown on agent cards in the UI. Describes what I''m an expert in, not what project I''m currently on. Max 100 chars.'
    WHEN 'team' THEN 'One-line headline of my enduring role — shown on agent cards. Describes the team I lead, not the project we''re on. Max 100 chars.'
    WHEN 'org' THEN 'One-line headline of my org-level role — shown on agent cards. Describes the scope I oversee, not the current project. Max 100 chars.'
  END
FROM agent a
WHERE a.archived_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM core_memory_block b2
    WHERE b2.agent_id = a.id AND b2.block_name = 'tag_line'
  );
