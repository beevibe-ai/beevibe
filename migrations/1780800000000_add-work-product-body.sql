-- Adds work_product.body so specialists can persist the actual deliverable
-- content (extracted tables, parsed analysis, full documents). Before this
-- column, content was either stashed in metadata or stranded in
-- session_event transcripts the dispatching agent could not see.

ALTER TABLE work_product
  ADD COLUMN body TEXT;
