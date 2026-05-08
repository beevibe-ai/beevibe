-- Onboarding state for the welcome wizard (lifted from feature branch
-- ahead of the full #63 signup PR — chat needs the column to know
-- whether to inject ONBOARDING_DIRECTIVES on a turn).
--
-- A NULL value means the person hasn't finished onboarding; a timestamp
-- means they have. The chat route flips it on the first successful chat
-- turn. The web's `/welcome` route (lands with #63) reads it.
--
-- Backfilled to NOW() for any existing rows so pre-existing users skip
-- the wizard once #63's UI lands.

ALTER TABLE person
  ADD COLUMN onboarding_completed_at TIMESTAMPTZ NULL;

UPDATE person SET onboarding_completed_at = NOW();
