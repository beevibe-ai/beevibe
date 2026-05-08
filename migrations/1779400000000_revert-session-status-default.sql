-- session.status DEFAULT is 'running'; the daemon-claim path passes
-- 'pending' explicitly when it wants the new flow.

ALTER TABLE session ALTER COLUMN status SET DEFAULT 'running';
