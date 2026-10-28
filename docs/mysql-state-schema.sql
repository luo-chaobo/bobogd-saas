-- Optional schema reference for the legacy single-state MySQL mode.
-- SaaS mode uses a separate catalog database and one app_state table per tenant database.
CREATE TABLE IF NOT EXISTS app_state (
  name VARCHAR(80) PRIMARY KEY,
  value_json JSON NOT NULL,
  updated_at DATETIME NOT NULL
);
