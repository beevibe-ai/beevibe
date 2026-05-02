-- Onboarding state for the welcome wizard (#48 follow-up).
--
-- A NULL value means the person hasn't finished onboarding; a timestamp
-- means they have. The web's `/welcome` route redirects to `/` when this
-- column is set; the chat route flips it on the first successful chat
-- turn so the wizard can't trap users with a stuck UX.
--
-- Backfilled to NOW() for any existing rows so pre-existing users skip
-- the wizard.

ALTER TABLE person
  ADD COLUMN onboarding_completed_at TIMESTAMPTZ NULL;

UPDATE person SET onboarding_completed_at = NOW();
