-- Local-only setup. Replace every password placeholder with a different strong value.
-- Run as a local MySQL administrator. Never point this at production.

CREATE DATABASE IF NOT EXISTS bobo_saas_catalog_local
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'bobo_saas_catalog_app'@'127.0.0.1'
  IDENTIFIED BY 'REPLACE_WITH_CATALOG_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON bobo_saas_catalog_local.* TO 'bobo_saas_catalog_app'@'127.0.0.1';

CREATE DATABASE IF NOT EXISTS bobo_tenant_future_machinery
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS bobo_tenant_future_machinery.app_state (
  name VARCHAR(80) PRIMARY KEY,
  value_json JSON NOT NULL,
  updated_at DATETIME NOT NULL
);
CREATE USER IF NOT EXISTS 'bobo_tenant_future_machinery_app'@'127.0.0.1'
  IDENTIFIED BY 'REPLACE_WITH_FUTURE_MACHINERY_TENANT_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE
  ON bobo_tenant_future_machinery.* TO 'bobo_tenant_future_machinery_app'@'127.0.0.1';

FLUSH PRIVILEGES;
