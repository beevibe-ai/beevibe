-- Phase 3 follow-up: revert session.status DEFAULT to 'running'.
--
-- Phase 1's migration (1779200000000) flipped the default to 'pending' for
-- the daemon-claim flow, but the legacy in-process executor (still active
-- through Phase 5) expects sessions to start in 'running' — DispatchService
-- passes status='pending' explicitly when it wants the new flow. Aligning
-- the DB default back to 'running' keeps the two paths from accidentally
-- diverging based on whether the INSERT specifies the column.

ALTER TABLE session ALTER COLUMN status SET DEFAULT 'running';
