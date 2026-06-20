-- Stores public newsletter interest for the Beevibe community layer.
-- Delivery tooling can sync from this table without making the core API
-- depend on a newsletter vendor.

CREATE TABLE newsletter_subscriber (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  source     TEXT NOT NULL DEFAULT 'community',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_newsletter_subscriber_created_at
  ON newsletter_subscriber(created_at DESC);
