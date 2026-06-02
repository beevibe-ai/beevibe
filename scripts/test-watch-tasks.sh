#!/usr/bin/env bash
# E2E smoke for watch_tasks against a running local stack. Verifies:
#   1. INSERT task_watch with mode='all' on a pair of in_progress tasks
#      does not fire on the first done transition; fires on the second.
#   2. The wake row has prior_session_id pointing at the waiter,
#      status='pending', and a structured intent that lists both tasks.
#
# Prereqs:
#   - Docker postgres running with beevibe DB migrated (pnpm dev brings
#     this up).
#   - psql available on $PATH (or fall back to `docker exec`).
#
# This is a DB-level smoke — it does NOT call the LLM. WatchService /
# watch_tasks tool / lifecycle prompt coverage lives in the vitest
# integration suites (watch-fire.db.test.ts + watch-service.test.ts +
# mcp.test.ts + assemble.test.ts). What this script proves end-to-end
# is that the trigger fires under real psql traffic with the same
# defaults pnpm dev applies — guards against migration drift that the
# vitest beevibe_test DB can't catch.

set -euo pipefail

PSQL() {
  docker exec -i beevibe-postgres psql -U beevibe -d beevibe -At -F'|' "$@"
}

uniq() { date +%s%N | tail -c 13; }
PERSON_ID="person_e2ew_$(uniq)"
TEAM_ID="agent_e2ew_$(uniq)"
IC_ID="agent_e2ew_$(uniq)2"
WAITER_ID="sess_e2ew_$(uniq)"
TASK_A="task_e2ew_$(uniq)A"
TASK_B="task_e2ew_$(uniq)B"
IC_A="sess_e2ew_$(uniq)A"
IC_B="sess_e2ew_$(uniq)B"
WATCH_ID="watch_e2ew_$(uniq)"

echo "==> Seeding fixture"
PSQL <<SQL >/dev/null
INSERT INTO person (id, name) VALUES ('$PERSON_ID', 'e2e-watch-tasks');

INSERT INTO agent (id, name, owner_id, hierarchy_level, runtime_config)
VALUES (
  '$TEAM_ID', 'team', '$PERSON_ID', 'team',
  '{"type":"claude-code","model":"claude-opus-4-7"}'::jsonb
);
INSERT INTO agent (id, name, owner_id, hierarchy_level, parent_agent_id, runtime_config)
VALUES (
  '$IC_ID', 'ic', '$PERSON_ID', 'ic', '$TEAM_ID',
  '{"type":"claude-code","model":"claude-opus-4-7"}'::jsonb
);

INSERT INTO session (id, agent_id, type, status, intent, conversation_id)
VALUES ('$WAITER_ID', '$TEAM_ID', 'chat', 'succeeded', 'waiter', '$WAITER_ID');

INSERT INTO task (id, title, description, priority, status, assignee_id, creator_id, creator_type)
VALUES ('$TASK_A', 'Backend', 'b', 'medium', 'in_progress', '$IC_ID', '$TEAM_ID', 'agent'),
       ('$TASK_B', 'Frontend', 'f', 'medium', 'in_progress', '$IC_ID', '$TEAM_ID', 'agent');

INSERT INTO session (id, agent_id, task_id, parent_session_id, type, status, intent)
VALUES ('$IC_A', '$IC_ID', '$TASK_A', '$WAITER_ID', 'task', 'running', '<task id="$TASK_A"/>'),
       ('$IC_B', '$IC_ID', '$TASK_B', '$WAITER_ID', 'task', 'running', '<task id="$TASK_B"/>');

INSERT INTO task_watch (id, waiter_session_id, agent_id, mode, task_ids)
VALUES ('$WATCH_ID', '$WAITER_ID', '$TEAM_ID', 'all', ARRAY['$TASK_A','$TASK_B']);
SQL

echo "==> Marking task A done (should NOT fire mode='all')"
PSQL <<SQL >/dev/null
UPDATE task SET status = 'done', result_summary = 'shipped backend' WHERE id = '$TASK_A';
SQL

STATUS_AFTER_FIRST=$(PSQL -c "SELECT status FROM task_watch WHERE id='$WATCH_ID'")
if [[ "$STATUS_AFTER_FIRST" != "waiting" ]]; then
  echo "FAIL: watch fired on first done; status=$STATUS_AFTER_FIRST"
  exit 1
fi
echo "    OK: watch still waiting"

echo "==> Marking task B done (should fire)"
PSQL <<SQL >/dev/null
UPDATE task SET status = 'done', result_summary = 'shipped frontend' WHERE id = '$TASK_B';
SQL

STATUS_AFTER_SECOND=$(PSQL -c "SELECT status FROM task_watch WHERE id='$WATCH_ID'")
if [[ "$STATUS_AFTER_SECOND" != "fired" ]]; then
  echo "FAIL: watch did not fire after both tasks done; status=$STATUS_AFTER_SECOND"
  exit 1
fi
echo "    OK: watch fired"

FIRED_SID=$(PSQL -c "SELECT fired_session_id FROM task_watch WHERE id='$WATCH_ID'")
if [[ -z "$FIRED_SID" ]]; then
  echo "FAIL: fired_session_id is null"
  exit 1
fi

WAKE_STATUS=$(PSQL -c "SELECT status FROM session WHERE id='$FIRED_SID'")
WAKE_TYPE=$(PSQL -c "SELECT type FROM session WHERE id='$FIRED_SID'")
WAKE_PRIOR=$(PSQL -c "SELECT prior_session_id FROM session WHERE id='$FIRED_SID'")
WAKE_AGENT=$(PSQL -c "SELECT agent_id FROM session WHERE id='$FIRED_SID'")

if [[ "$WAKE_STATUS" != "pending"
      || "$WAKE_TYPE"   != "chat"
      || "$WAKE_PRIOR"  != "$WAITER_ID"
      || "$WAKE_AGENT"  != "$TEAM_ID" ]]; then
  echo "FAIL: wake session shape mismatch"
  echo "  expected: status=pending type=chat prior=$WAITER_ID agent=$TEAM_ID"
  echo "  actual:   status=$WAKE_STATUS type=$WAKE_TYPE prior=$WAKE_PRIOR agent=$WAKE_AGENT"
  exit 1
fi
echo "    OK: wake session shape ($WAKE_STATUS/$WAKE_TYPE, chained to waiter)"

WAKE_INTENT=$(PSQL -c "SELECT intent FROM session WHERE id='$FIRED_SID'")
for needle in "2 tasks completed" "Backend" "Frontend" "Decide next steps."; do
  if [[ "$WAKE_INTENT" != *"$needle"* ]]; then
    echo "FAIL: wake intent missing '$needle'"
    echo "  got: $WAKE_INTENT"
    exit 1
  fi
done
echo "    OK: wake intent lists both tasks"

echo "==> Cleanup"
PSQL <<SQL >/dev/null
DELETE FROM task_watch WHERE id = '$WATCH_ID';
DELETE FROM session WHERE id IN ('$IC_A','$IC_B','$WAITER_ID','$FIRED_SID');
DELETE FROM task WHERE id IN ('$TASK_A','$TASK_B');
DELETE FROM agent WHERE id IN ('$TEAM_ID','$IC_ID');
DELETE FROM person WHERE id = '$PERSON_ID';
SQL

echo "==> All checks passed."
