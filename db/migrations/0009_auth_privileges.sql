-- Up Migration
-- Explicit, minimal grants for the application role.
-- users: no UPDATE, no DELETE. user_sessions: only last_seen_at and revoked_at may change.
-- audit_logs: INSERT only (append-only; the app cannot even read it).
GRANT SELECT, INSERT ON users TO vantage_app;
GRANT SELECT, INSERT ON user_sessions TO vantage_app;
GRANT UPDATE (last_seen_at, revoked_at) ON user_sessions TO vantage_app;
GRANT INSERT ON audit_logs TO vantage_app;
GRANT USAGE ON SEQUENCE audit_logs_id_seq TO vantage_app;
