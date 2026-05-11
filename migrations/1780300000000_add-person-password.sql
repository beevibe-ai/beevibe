-- Phase 5 follow-up: human credential auth.
--
-- Adds password_hash to person so /sign-in can validate {email, password}
-- and return the existing bv_u_ key on match. Existing rows land with
-- password_hash = NULL — the legacy "paste your bv_u_ key" sign-in path
-- still works for them as a fallback. New signups will set this.
--
-- We hash with Node's stdlib scrypt (no extra dep, no native bindings,
-- OWASP-approved for password storage). Format stored as one TEXT field:
--
--   scrypt$N=...,r=...,p=...$<salt-hex>$<derived-hex>
--
-- A future column rotation can bump cost params without breaking older
-- rows because each hash is self-describing.

ALTER TABLE person ADD COLUMN password_hash TEXT;

-- Down: keep this trivial — drop the column. Rows with passwords are
-- discarded; users fall back to bv_u_ paste sign-in.
