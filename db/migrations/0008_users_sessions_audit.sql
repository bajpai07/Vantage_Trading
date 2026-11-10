-- Up Migration
-- DATABASE section 2 (enums) and section 3 (identity and security), plus the foreign key that M1
-- postponed (D-38): accounts.user_id REFERENCES users(id).
CREATE TYPE user_role   AS ENUM ('USER','SUPPORT','ADMIN','SUPERADMIN');
CREATE TYPE user_status AS ENUM ('PENDING_VERIFICATION','ACTIVE','SUSPENDED','DELETED');

CREATE TABLE users (
  id               uuid PRIMARY KEY,
  email            citext NOT NULL UNIQUE,
  email_verified_at timestamptz,
  password_hash    text NOT NULL,                 -- Argon2id
  role             user_role NOT NULL DEFAULT 'USER',
  status           user_status NOT NULL DEFAULT 'PENDING_VERIFICATION',
  display_name     text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 40),
  country_code     char(2),
  is_adult         boolean NOT NULL,              -- no DOB stored (ASSUMPTION, PRD section 2)
  totp_secret_enc  bytea,                         -- P2
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  -- M2: no leading or trailing whitespace in the stored email (uniqueness stays case-insensitive via citext)
  CONSTRAINT users_email_trimmed_chk CHECK (email::text !~ '^\s|\s$')
);

CREATE TABLE user_sessions (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,             -- SHA-256 of the opaque token
  ip           inet, user_agent text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX user_sessions_user_idx ON user_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_sessions_exp_idx  ON user_sessions(expires_at);

CREATE TABLE audit_logs (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES users(id),
  actor_role user_role,
  action     text NOT NULL,
  target_type text, target_id text,
  before     jsonb, after jsonb,
  ip         inet, request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_idx  ON audit_logs(actor_id, created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs(target_type, target_id);

-- audit_logs is append-only (same trigger function as the ledger, row and TRUNCATE).
CREATE TRIGGER audit_log_immutable   BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- D-38: every account belongs to a real user.
ALTER TABLE accounts ADD CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
