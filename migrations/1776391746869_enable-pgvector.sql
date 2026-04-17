-- Up Migration
CREATE EXTENSION IF NOT EXISTS vector;

-- Down Migration
DROP EXTENSION IF EXISTS vector;
