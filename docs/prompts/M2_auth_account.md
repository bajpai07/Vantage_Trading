# VANTAGE · Claude Code Prompt · M2 — AUTH AND ACCOUNT (backend)

Environment and rules carry over from M0 and M1: native Windows, PowerShell, Docker Desktop, repo at `C:\dev\vantage` (not in OneDrive), Node 22.19.0, Postgres port from `POSTGRES_HOST_PORT`, exact dependency versions, LF endings, no secrets in git or on command lines, stop-and-report on ambiguity, never mark anything passed unless you ran it, no push, and no UI.

## 1. Goal

A user can **register, log in, log out, see their profile, and see their account balance**, and a new user's $10,000 starting balance is a real ledger GRANT created in the same database transaction as the user. Backend only: NestJS app, a small `contracts` package, a few migrations, tests. No market data, orders, watchlists, positions, UI, email sending or Redis.

Read first: DATABASE §2 (enum list), §3, §6; PRD (auth, onboarding, account requirements and the age assumption); ARCHITECTURE §1–2 and §9 (security); `docs/ledger.md`; the M1 report. If a spec is ambiguous or contradicts this prompt, stop and report.

## 2. Step 0

1. Make sure `main` contains M1 (`git merge --no-ff phase/m1-ledger` locally if not). Create branch `phase/m2-auth`.
2. `pnpm install --frozen-lockfile`, `pnpm db:up`, `pnpm db:migrate`, `pnpm verify` must pass before you change anything. If the local database has stale passwords, use `pnpm db:reset`. Otherwise stop and report.

## 3. Decisions for this phase (record them in DECISIONS, status `APPROVED by founder (M2)` unless you object with a reason)

- **D-41 IDs:** all new IDs are **UUIDv7** generated in `apps/api` through one `newId()` function (pinned `uuid` package). The engine/money packages never generate IDs. Existing M1 code keeps working; new code uses `newId()`.
- **D-42 User status:** email verification is deferred to the closed-beta hardening phase (M8). Until then, new users are created with `status = 'ACTIVE'` and `email_verified_at = NULL` (this deviates from the DATABASE default `PENDING_VERIFICATION`). Trading and balance endpoints require `status = 'ACTIVE'`.
- **D-43 Data access:** Prisma is **not introduced in M2**. Registration must create the user, the account, the ledger accounts and the GRANT in **one** `pg` transaction, which Prisma cannot join with the ledger repository. Prisma arrives with the first non-ledger CRUD table (watchlists, M3). Ledger and registration always use `pg`.
- **D-44 Ledger hardening from M1 review:** (a) the entry currency must equal its ledger account's currency (added in M1; note it in DATABASE §6 as an append-only note); (b) a ledger transaction must have at least one entry at commit (new constraint trigger in T1).

## 4. Tasks (in order; verify each; commit after each)

**T1 · Migrations (plain SQL, forward-only).** Numbering continues after the last M1 migration.
1. `ledger_transactions` **must have entries:** a DEFERRABLE INITIALLY DEFERRED constraint trigger on `ledger_transactions` that fails at commit if the transaction has no `ledger_entries` row. (A balanced transaction of non-zero entries then necessarily has at least two.)
2. Enums `user_role`, `user_status` (DATABASE §2). Tables `users`, `user_sessions`, `audit_logs` exactly as DATABASE §3. Add the deferred foreign key from M1: `accounts.user_id REFERENCES users(id)` (D-38). `audit_logs` is append-only (reuse `forbid_mutation` row and TRUNCATE triggers).
3. Grants to `vantage_app` (explicit, minimal): `users`: `SELECT`, `INSERT` (no UPDATE, no DELETE); `user_sessions`: `SELECT`, `INSERT`, and `UPDATE (last_seen_at, revoked_at)` only; `audit_logs`: `INSERT` and the sequence `USAGE`. Nothing else. Revoke EXECUTE from PUBLIC on any new function.
4. Add a CHECK that `email` has no leading or trailing whitespace; keep `citext` unique (case-insensitive).
- Done when: migrations apply twice (second no-op), and a test proves a transaction with zero entries is rejected at commit while normal posting still works.

**T2 · `@vantage/contracts` (Zod; depends on no internal package).** Schemas and inferred types: `RegisterRequest` (email, password, displayName 2–40 chars, countryCode ISO-3166 alpha-2 from a bundled list, `confirmAdult: true` literal, `acceptTerms: true` literal), `LoginRequest`, `MeResponse`, `AccountResponse` (`currency: "USD"`, `cash`, `equity`, `initialCapital`, `asOf`), `ErrorEnvelope` (`{ error: { code, message, requestId } }`). **All money fields are decimal strings**, never numbers. Password policy: 10–128 characters, must not equal the email. Email normalised (trim, lower-case for comparison; stored as given trimmed).

**T3 · NestJS app skeleton (`apps/api`).**
- NestJS with the default Express adapter, pinned exact versions. Keep the M0 `--check` contract working (config only, no network, exits 0/2/64) alongside normal start.
- **Config additions** in `@vantage/config` (application config only, no migration credentials): `PORT`, `WEB_ORIGIN` (single allowed origin), `SESSION_IDLE_MINUTES` (default 480), `SESSION_ABSOLUTE_DAYS` (default 7), `COOKIE_SECURE` (true by default; false allowed only in `local`/`test`). Keep every M0 guard.
- Modules with clean boundaries (a module imports another only through its exported service): `config`, `db` (a `pg` Pool provider; the app connects as `vantage_app` only), `health`, `auth`, `users`, `accounts`, `ledger` (move/wrap the M1 repository), `audit`.
- Cross-cutting: request id (reuse the incoming `x-request-id` only if it matches a safe pattern; else generate), one global exception filter producing the `ErrorEnvelope` (never leak stack traces or SQL), Zod validation pipe, JSON body limit 100 KB, `x-powered-by` disabled, basic security headers, CORS only for `WEB_ORIGIN` with credentials. Structured JSON logs through the existing `log.ts` (no `console`); **never log passwords, cookies, session tokens or full request bodies**.
- **Pitfalls to verify (do not assume):** Nest decorators with `verbatimModuleSyntax`, `isolatedModules` and Vitest (esbuild does not emit decorator metadata). Prefer explicit `@Inject(TOKEN)` everywhere so nothing depends on emitted metadata. If a tsconfig override is needed in `apps/api` only, make it there and record it. If Nest does not work with the pinned TypeScript 6.0.3, stop and report options.
- Endpoints: `GET /health` (liveness) and `GET /health/ready` (runs `SELECT 1`; returns 503 if the database is unreachable).
- Done when: the app starts against the local database, both health endpoints behave, and `--check` still passes.

**T4 · Auth core.**
- **Password hashing:** Argon2id, with explicit parameters (at least 19 MiB memory, time cost 2, parallelism 1) kept in one config constant. Use a library that works on Windows with Node 22 (try `@node-rs/argon2` first, or `argon2`); if neither installs, stop and report. Hashes are stored as the library's encoded string (`$argon2id$…`).
- **Sessions:** opaque token = 32 random bytes from `crypto.randomBytes`, base64url. Store only its SHA-256 (`token_hash`). Cookie `vantage_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` per config, `Max-Age` = absolute lifetime. Sliding idle expiry: update `last_seen_at` at most once per minute; reject if idle > `SESSION_IDLE_MINUTES`, if past `expires_at`, or if `revoked_at` is set. Logging in creates a new session (never reuse a token). Store `ip` and `user_agent`.
- **CSRF:** every state-changing request (POST/PUT/PATCH/DELETE) must carry an `Origin` (or, if absent, `Referer`) header equal to `WEB_ORIGIN`; otherwise 403. This is the primary defence, together with `SameSite=Lax`.
- **No user enumeration on login:** wrong password and unknown email return the same status, code and message, and the unknown-email path still performs a dummy Argon2 verification (test that the verifier is called in both cases). Registration with an existing email returns 409 `EMAIL_TAKEN` (accepted trade-off until email verification exists; rate limiting covers abuse).
- **Rate limiting (in memory, single process; document the limitation):** failed logins 5 per 15 minutes per (IP, email) and 20 per 15 minutes per IP; registrations 10 per hour per IP; exceeding returns 429 with `Retry-After`. The limiter is a small pure class with an injectable clock and unit tests.
- **Audit:** write `audit_logs` rows for `USER_REGISTERED`, `LOGIN_SUCCEEDED`, `LOGIN_FAILED` (no password; email only as a hash prefix, never plaintext), `LOGOUT`. Audit failures must not block login, but must be logged.

**T5 · Endpoints and the registration transaction.**
- `POST /v1/auth/register`: validate; in **one `pg` transaction**: insert the user (`ACTIVE`, `role USER`, `is_adult true`), create the MAIN account with `initial_capital = 10000` USD, create the standard ledger accounts, post the GRANT through the M1 repository (`grantInitialCapital`), create a session; commit; set the cookie; return 201 with `MeResponse`. If any step fails, **nothing** exists afterwards (no user, account, ledger row or session).
- `POST /v1/auth/login`, `POST /v1/auth/logout` (revokes the current session; always clears the cookie), `GET /v1/me`, `GET /v1/account`.
- `GET /v1/account`: cash from the CASH ledger account, `initialCapital`, `equity` (equal to cash for now, as there are no positions yet), `asOf` (server time). Money fields are **canonical decimal strings** from a new `toCanonicalString` in `@vantage/money` (minimum 2 decimal places, trailing zeros beyond that trimmed; `"10000.00"`, `"1900.4015"`). Display rounding is a UI concern.
- Unauthenticated access to `/v1/me` and `/v1/account` returns 401 with the error envelope.

**T6 · Tests** (real Postgres via the existing `createTestDatabase()`; Nest app created per test file against that database as `vantage_app`; HTTP via `supertest`). Every "must fail" has a control that succeeds.
1. Register: 201, cookie has `HttpOnly` and `SameSite=Lax`; DB row has an `$argon2id$` hash (not the password); account `initial_capital = 10000`; ledger shows `CASH = 10000`, `CAPITAL = -10000`; `reconcileAccount` clean; exactly one GRANT with key `grant:<accountId>`.
2. Registration is atomic: force a failure at the GRANT step (dependency override) and prove no user, account, ledger rows or session remain. Duplicate email (different case) returns 409 and creates **no** second account or ledger rows.
3. Validation: `confirmAdult false`, bad country, weak password, password equal to email, display name too short: all rejected with the envelope and nothing written; the valid control succeeds.
4. Login: success sets a new session; wrong password and unknown email give identical responses and both run the verifier; a tampered, expired (advance an injected clock), idle-expired or revoked cookie gets 401; logout revokes and the same cookie then fails.
5. CSRF: a POST with a wrong `Origin` or none gets 403; the correct `Origin` works.
6. Rate limit: the 6th failed login for the same (IP, email) gets 429 with `Retry-After`; a different email from the same IP is unaffected until the per-IP limit.
7. Privileges (as `vantage_app` through the real app connection): the app cannot `UPDATE` or `DELETE` `users`, cannot `UPDATE` `user_sessions.token_hash`, and cannot modify `audit_logs`; control: allowed operations work. `audit_logs` rows exist for register, login success, login failure and logout.
8. `/v1/account` money is a string, never a number; a user cannot read another user's account.
9. Health: `/health/ready` returns 503 when the pool is pointed at a closed database (use a test double), 200 otherwise. No response, log line or error ever contains the password, the cookie value or a stack trace (assert on captured logs and bodies).
- Done when: `pnpm verify` is green and `pnpm test:integration` passes **twice in a row**, with no leftover `t_*` databases.

**T7 · Docs and decisions.**
- `docs/api.md` (short): endpoints, request/response shapes, error codes, cookie and CSRF rules, rate-limit values.
- Append D-41 to D-44 to the `docs/specs/DECISIONS.md` table (without editing existing lines; zero deletions), and the D-44(a) note to DATABASE §6 (append only).
- README: update the quickstart with how to start the API locally (`node --env-file=.env …`) and the required `WEB_ORIGIN`.

## 5. Out of scope (do not build)
Email sending or verification; password reset; password change; profile editing; MFA/TOTP; OAuth; admin or roles beyond the `USER` default; any market-data, instrument, watchlist, order, position or P&L code; Prisma; Redis; WebSocket; UI; deployment.

## 6. Common mistakes
Storing the raw session token; logging cookies or passwords; different responses for wrong password vs unknown email; skipping the dummy hash; non-atomic registration (user created, grant failed); granting the app UPDATE on `users`; returning money as numbers; trusting `X-Forwarded-For` blindly for rate limits (use the socket address unless a configured trusted-proxy setting says otherwise; document it); string-concatenated SQL; swallowing the audit error silently; Nest DI relying on emitted decorator metadata; editing old migrations.

## 7. Verification (clean clone of the branch)
```powershell
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate ; pnpm db:migrate ; pnpm db:status
pnpm verify
pnpm test:integration          # second consecutive run
node apps/api/dist/main.js --check
pnpm db:down
```

## 8. Acceptance criteria (run each; PASS / FAIL / UNVERIFIED)
1. Step 0 baseline green.
2. A transaction with no entries is rejected at commit; normal posting unaffected.
3. Registration is atomic and creates user, MAIN account, ledger accounts and exactly one GRANT; ledger reconciles clean.
4. Passwords stored as Argon2id; the session token is stored only as a SHA-256 hash; cookie flags correct.
5. Login responses are indistinguishable for wrong password and unknown email; the verifier runs in both.
6. Expired, idle, tampered and revoked sessions are rejected; logout revokes.
7. CSRF origin rule enforced on all state-changing routes.
8. Rate limits enforced (429 + Retry-After) and unit-tested with an injected clock.
9. `vantage_app` privilege tests pass (no UPDATE/DELETE on `users`, no token-hash updates, audit append-only).
10. Money fields are strings; users cannot read other users' accounts; unauthenticated gets 401.
11. No secret, cookie or stack trace appears in any response or captured log.
12. `/health` and `/health/ready` behave as specified; `--check` still exits 0/2/64.
13. `pnpm verify` green; integration green twice in a row; no leftover test databases.
14. `docs/api.md` written; D-41 to D-44 appended with zero deletions.

## 9. Final report (`docs/phase-reports/M2-report.md`, also printed)
1. Status: READY / READY WITH CAVEATS / NOT READY for M3 (≤ 5 lines).
2. New dependency versions and how verified (including the Argon2 library and why).
3. Task status T1–T7.
4. Files created / modified.
5. Commands run with exit codes and durations; failing output verbatim.
6. Acceptance table (14 items) with evidence.
7. Test list, each "must fail" with its control.
8. Deviations, surprises, spec questions (stop-and-report format), including any Nest/TypeScript compatibility workaround.
9. Known limitations (in-memory rate limits, no email verification, CI not run) and M3 readiness.

Do not start M3. Stop after the report.
