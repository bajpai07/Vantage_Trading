#!/bin/bash
# Runs once, on an empty data volume, inside the postgres container (official image init).
set -Eeuo pipefail

for v in POSTGRES_PASSWORD VANTAGE_MIGRATOR_PASSWORD VANTAGE_APP_PASSWORD; do
  val="${!v:-}"
  if [[ -z "$val" ]]; then
    echo "bootstrap: required variable $v is missing" >&2
    exit 1
  fi
  if [[ "$val" == change-me* ]]; then
    echo "bootstrap: $v still has a placeholder value (run pnpm setup:env)" >&2
    exit 1
  fi
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
SET log_statement = 'none';
\getenv migrator_pw VANTAGE_MIGRATOR_PASSWORD
\getenv app_pw VANTAGE_APP_PASSWORD

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', 'vantage_migrator', :'migrator_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vantage_migrator') \gexec

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', 'vantage_app', :'app_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vantage_app') \gexec

SELECT 'CREATE DATABASE vantage_dev OWNER vantage_migrator'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'vantage_dev') \gexec

\connect vantage_dev
SET log_statement = 'none';
REVOKE ALL ON DATABASE vantage_dev FROM PUBLIC;
GRANT CONNECT ON DATABASE vantage_dev TO vantage_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vantage_app;
ALTER DEFAULT PRIVILEGES FOR ROLE vantage_migrator REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE vantage_migrator REVOKE ALL ON SEQUENCES FROM PUBLIC;
SQL
