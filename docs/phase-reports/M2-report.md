# M2 report — Auth and account (backend)

Branch `phase/m2-auth` (not pushed), based on `main` after a local `--no-ff` merge of `phase/m1-ledger` (`e163b35`). Run date 2026-11-10/11.

## 1. Status

**READY WITH CAVEATS for M3.**

- T1–T7 are done and verified on a clean clone: `pnpm verify` green (171 unit and 91 integration tests), and `pnpm test:integration` green a second time, with no leftover `t_*` databases. `--check` exits 0, 2 and 64.
- Caveats: in-memory rate limits, no email verification (D-42), proxy headers not trusted, CI never executed, 0600 unverified on Windows, and six spec questions below that I resolved conservatively.

## 2. New dependency versions

All exact; script check: 0 non-exact.

| Dependency                                      | Version                                                       | Verified / why                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| @nestjs/common, core, platform-express, testing | 12.4.2                                                        | `npm view`, `pnpm ls`; app starts and 91 integration tests pass. Nest 12 is ESM, which fits NodeNext                                                                                                                                                         |
| reflect-metadata, rxjs                          | 0.2.2, 7.8.2                                                  | Nest requirements                                                                                                                                                                                                                                            |
| express types / supertest                       | @types/express 5.0.6, supertest 7.3.2, @types/supertest 7.2.1 | HTTP tests                                                                                                                                                                                                                                                   |
| uuid                                            | 14.0.3                                                        | `v7()` behind one `newId()` (D-41); a test asserts the version nibble is 7                                                                                                                                                                                   |
| @node-rs/argon2                                 | 2.2.2                                                         | **Argon2 library choice:** tried first, as instructed. It installs on native Windows with Node 22.19.0 (prebuilt binary, no compiler), hashes in about 33 ms with m=19456, t=2, p=1, and returns `$argon2id$v=19$m=19456,t=2,p=1$…`. `argon2` was not needed |
| zod                                             | 4.6.7                                                         | already pinned; now also in `apps/api` and the new `contracts` package                                                                                                                                                                                       |

Nest and TypeScript 6.0.3 work together with no workaround other than one `apps/api`-only tsconfig option (section 8).

## 3. Task status

| Task                    | Status | Note                                                                                                                                                                                                                                              |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 Migrations           | DONE   | 0007 (transaction must have entries), 0008 (enums, `users`, `user_sessions`, `audit_logs`, FK `accounts.user_id`, email whitespace CHECK, append-only audit triggers), 0009 (minimal grants). Apply twice, second is a no-op                      |
| T2 `@vantage/contracts` | DONE   | Zod schemas, bundled 249-code ISO list; `toCanonicalString` added to `@vantage/money`. Depends on no internal package                                                                                                                             |
| T3 NestJS skeleton      | DONE   | Modules `config`, `db`, `health`, `auth`, `users`, `accounts`, `ledger`, `audit` (+ session submodule); request id, error envelope filter, Zod pipe, 100 KB body limit, security headers, CORS for one origin, JSON logger. `--check` still works |
| T4 Auth core            | DONE   | Argon2id, hashed opaque sessions, CSRF origin guard, no enumeration with dummy verification, in-memory limiters with injected clock, audit rows                                                                                                   |
| T5 Endpoints            | DONE   | register (one transaction), login, logout, `/v1/me`, `/v1/account`                                                                                                                                                                                |
| T6 Tests                | DONE   | 46 new integration tests, 7 limiter unit tests, plus contracts, money and config tests                                                                                                                                                            |
| T7 Docs and decisions   | DONE   | `docs/api.md`, README, D-41 to D-44 and the DATABASE §6 note (0 deletions)                                                                                                                                                                        |

## 4. Files

Created: `db/migrations/0007`–`0009`; `packages/contracts/*`; `apps/api/src/{ids,log,tokens,app.module,configure-app,bootstrap}.ts`; `apps/api/src/common/*` (errors, http helpers, filter, Zod pipe, CSRF guard, module); `apps/api/src/modules/{config,db,health,audit,users,accounts,auth}/*`; `apps/api/src/modules/ledger/{errors,reconcile,repository,ledger.service}.ts` (the M1 repository files are unchanged; a Nest wrapper was added); `apps/api/src/testing/harness.ts`; integration tests `register`, `session`, `security`; `rate-limiter.test.ts`; `docs/api.md`; `docs/prompts/M2_auth_account.md`; this report.

Modified: `apps/api/src/{main,run,api.test}.ts` (start mode; exit 64 now means an unknown argument), `apps/api/package.json` and tsconfigs, `packages/config/*` (new settings), `packages/money/*` (`toCanonicalString`), `eslint.config.mjs` (no-console in the API, ledger module boundary), `vitest.config.ts` (contracts alias, 30 s unit timeout), `.env.example`, `README.md`, `pnpm-lock.yaml`, M1 `ledger.int.test.ts` (tests now create a real user because of the new foreign key, one test updated for the new commit-time rule, and group 10 added), `docs/specs/DATABASE.md` (+2 lines), `docs/specs/DECISIONS.md` (+4 rows), both with 0 deletions.

## 5. Commands run (clean clone of the branch)

| Command                                              | Exit | Time                                                                 |
| ---------------------------------------------------- | ---- | -------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                     | 0    | 30 s                                                                 |
| `pnpm setup:env --port 55433`                        | 0    | 4 s                                                                  |
| `pnpm db:up`                                         | 0    | 14 s                                                                 |
| `pnpm db:migrate` (twice)                            | 0, 0 | 4 s, 4 s                                                             |
| `pnpm db:status`                                     | 0    | lists 0001–0009 applied                                              |
| `pnpm verify` (171 unit, 91 integration)             | 0    | 194 s                                                                |
| `pnpm test:integration` (second run)                 | 0    | 73 s                                                                 |
| `node --env-file=.env apps/api/dist/main.js --check` | 0    | `{"app":"api","status":"config_ok"}`                                 |
| same with an empty environment                       | 2    | lists `WEB_ORIGIN`, `APP_ENV` and the other missing names, no values |
| same with `--bogus`                                  | 64   | usage line                                                           |
| `pnpm db:down`                                       | 0    |                                                                      |

Leftover `t_*` databases: 0. The machine was busy, so timings are about twice those of M1.

Failures met along the way (all fixed):

1. **First clean-clone `verify` failed**, verbatim: `FAIL |unit| packages/money/src/money-guard.test.ts > money guard lint rules > bans parseFloat — Error: Test timed out in 5000ms.` and the same for `engine-guard.test.ts`. The ESLint-based guard tests load the whole flat config on first use, which is slow cold. Fixed with a 30 s unit-test timeout, then the whole clone run was repeated from scratch and passed. It had not shown in my in-repo runs because the cache was warm.
2. `Cannot access ambient const enums when 'verbatimModuleSyntax' is enabled` for `Algorithm` from `@node-rs/argon2`: fixed by using the value 2 (Argon2id) with a type-only import; a test asserts every hash starts with `$argon2id$v=19$m=19456,t=2,p=1$`.
3. `Cannot find module 'zod'` in `apps/api`: added the dependency.
4. Two of my scripted file edits corrupted a file (a JavaScript `replace` treats `$'` in the replacement text specially). Both were caught by lint or tests and rewritten with the file editor. A `\d` regex lost its backslash once in the config package and was caught by its own tests.
5. My test helper treated `undefined` as "use the default Origin", so a "no Origin" test sent one; the failing test caught it and the helper now uses `null`.

## 6. Acceptance table

| #   | Criterion                                                                             | Result | Evidence                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Step 0 baseline green                                                                 | PASS   | After the merge of M1: `install`, `db:up`, `db:migrate`, `verify` exit 0 (45 s, 117 unit and 41 integration tests)                                                                                                                                                                                                                        |
| 2   | Transaction with no entries rejected at commit; normal posting unaffected             | PASS   | `ledger.int.test.ts` group 10: `has no entries` at COMMIT, no row left; control posting and idempotent replay still work                                                                                                                                                                                                                  |
| 3   | Registration atomic; user, MAIN account, ledger accounts, one GRANT; reconciles clean | PASS   | `register.int.test.ts`: `initial_capital = 10000`, `CASH 10000`, `CAPITAL -10000`, one GRANT with key `grant:<accountId>`, `reconcileAccount` clean. Forced failure at the GRANT step: counts of users, accounts, ledger accounts, transactions, entries and sessions unchanged; duplicate email in another case: 409 and nothing created |
| 4   | Argon2id passwords; token stored only as SHA-256; cookie flags                        | PASS   | Hash starts with `$argon2id$v=19$m=19456,t=2,p=1$` and does not contain the password; `token_hash` equals SHA-256 of the cookie value (32 bytes) and the raw token appears in no column; cookie has `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=604800`, and `Secure` when configured                                                  |
| 5   | Login responses indistinguishable; verifier runs in both                              | PASS   | Same status, code and message; a spy hasher saw one `verify` per attempt, the unknown-email call used a different real `$argon2id$` dummy hash                                                                                                                                                                                            |
| 6   | Expired, idle, tampered, revoked rejected; logout revokes                             | PASS   | Injected clock: absolute (7 days), idle (30 min config) with a sliding control, five tampered or garbage cookies, logout then the same cookie gets 401, `revoked_at` set; touch limited to once a minute                                                                                                                                  |
| 7   | CSRF origin rule on all state-changing routes                                         | PASS   | login, register and logout each get 403 with a wrong origin, `null`, another port or no `Origin`; Referer fallback tested; right origin passes; GET needs none                                                                                                                                                                            |
| 8   | Rate limits (429 + Retry-After), unit-tested with injected clock                      | PASS   | 7 limiter unit tests; HTTP tests: 6th failed login per (IP, email), per-IP 20, registrations 11th, and each lifts when the injected clock advances                                                                                                                                                                                        |
| 9   | `vantage_app` privilege tests                                                         | PASS   | Through the app's own pool: UPDATE/DELETE/TRUNCATE on `users` denied; `token_hash`, `user_id`, `expires_at` updates denied; audit logs unreadable and unmodifiable; migrator also stopped by the audit triggers; controls: allowed updates work                                                                                           |
| 10  | Money fields are strings; no cross-user reads; unauthenticated gets 401               | PASS   | `cash`, `equity`, `initialCapital` are strings in the raw JSON (`"cash":"10000.00"`, `"8099.5985"`); another user's account is not reachable by query or path; 401 envelope for `/v1/me` and `/v1/account`                                                                                                                                |
| 11  | No secret, cookie or stack trace in any response or captured log                      | PASS   | Scan of every captured body and log line (including a forced 500 whose error text contained a fake password and SQL): no password, token, `"stack"`, stack frame, `node_modules`, SQL or `$argon2`                                                                                                                                        |
| 12  | `/health`, `/health/ready` behave; `--check` exits 0/2/64                             | PASS   | 200 and 200; 503 `NOT_READY` with a closed pool while `/health` stays 200; `--check` run on the built `dist/main.js` in the clone: 0, 2, 64                                                                                                                                                                                               |
| 13  | `pnpm verify` green; integration green twice; no leftover test databases              | PASS   | Section 5                                                                                                                                                                                                                                                                                                                                 |
| 14  | `docs/api.md` written; D-41 to D-44 appended with zero deletions                      | PASS   | `git diff --numstat e163b35 HEAD -- docs/specs`: `2 0 DATABASE.md`, `4 0 DECISIONS.md`                                                                                                                                                                                                                                                    |

## 7. Test list (each "must fail" with its control)

- **Register (8 tests):** the happy path (cookie flags, Argon2id row, hashed session token, account, ledger, reconcile, one GRANT); UUIDv7 ids; invalid bodies (confirmAdult false, acceptTerms false, bad country, short password, password equal to email, short display name, bad email, unknown field) each 400 with nothing written, control: the valid request succeeds; oversized body gets 413, malformed JSON 400.
- **Atomic:** failure at the GRANT step (provider override) leaves nothing, control: same email registers with the real service; duplicate email in a different case gets 409 with nothing created, control: the first registration worked.
- **Login and sessions (15 tests incl. CSRF and rate limits):** new session per login; wrong password versus unknown email identical with the verifier run in both; tampered, garbage and missing cookies get 401, control: the real cookie works; absolute expiry, idle expiry (control: sliding window), touch at most once a minute; logout revokes and clears (control: before logout it worked); logout without a session still clears; CSRF on three routes, Referer fallback, GET and CORS; 6th failed login 429 (control: another email unaffected and the right password works later), window slides, per-IP 20, registrations 10 per hour.
- **Security (16 tests):** privileges (`users`, `user_sessions`, `audit_logs`) with controls; audit rows for the four actions, email only as a hash prefix; an audit failure is logged and does not block the login; account money strings; two users isolated (control: bob unchanged after alice spends); 401 envelope (control: 200 with a session); suspended user gets 403 (control: active gets 200); health 200 and 503; request id reuse and replacement; unknown route envelope; leak scan.
- **Ledger (4 new tests):** zero-entry transaction rejected at commit (control: normal posting); account for a non-existent user rejected (control: existing user works); untrimmed email rejected and case-insensitive uniqueness.

## 8. Deviations, surprises, spec questions

**Nest and TypeScript compatibility workaround:** Nest needs legacy decorators, so `experimentalDecorators: true` is set in `apps/api/tsconfig.json` and `tsconfig.build.json` only. `emitDecoratorMetadata` stays off and every injection uses an explicit `@Inject(token)`, so nothing depends on emitted metadata. Vitest (esbuild) and `tsc` both worked with TypeScript 6.0.3 and Nest 12.4.2 on the first try; no stop was needed.

**Spec questions I resolved conservatively (please confirm):**

1. The prompt refers to "the existing `log.ts`", but M0 had none. I created `apps/api/src/log.ts` (JSON lines, recursive redaction of keys such as password, token, cookie, session and hash).
2. ARCHITECTURE section 6 says `/api/v1/...`, an error body with `details`, CSRF as Origin check plus a token, and Redis rate limits (auth 5/min/IP). The prompt says `/v1/...`, an envelope without `details`, Origin-only CSRF and in-memory limits. I followed the prompt.
3. PRD FR-ID-1 and FR-ID-4 require email verification, a breached-password check, and the grant on the first verified login; D-42 defers verification, and no breached-password check exists yet.
4. DATABASE section 3 gives `status` the default `PENDING_VERIFICATION`; the app writes `ACTIVE` explicitly (D-42) and the column default is unchanged.
5. The "deferred foreign key" from M1 is an ordinary immediate foreign key (`accounts_user_id_fkey`), because registration inserts the user before the account.
6. A suspended user logging in gets the same `INVALID_CREDENTIALS` as a wrong password, to avoid revealing the status.

**Other surprises:**

- The new foreign key and commit-time rule broke M1 test helpers (random user ids, an intentionally empty transaction). I fixed the tests, not the rules.
- `audit_logs` gives the app role INSERT only, so the app cannot even read it; audit rows are checked through the migrator in tests.
- The `session` key pattern in the log redactor also hides a field named `sessionId`; the code never logs one.
- The unit suite now needs a 30 s timeout for the guard tests (see failure 1).

## 9. Known limitations and M3 readiness

- **Rate limits are in memory** in one process: several API processes count separately and a restart clears them. `X-Forwarded-For` is not trusted and no trusted-proxy setting exists, so behind a proxy all clients would share one address.
- **No email verification** (D-42), no password reset or change, no profile editing, no MFA, no roles beyond USER. Registration discloses that an email is taken (409).
- Unchanged from earlier phases: file mode 0600 unverified on Windows; the CI workflow has never run (nothing pushed), so the new API tests first run in CI after the first push.
- The server listens on `127.0.0.1` only; a configurable host arrives with deployment work.
- Local state: this checkout's database was reset at the end of the clean-clone run and migrated to 0009. The `.env` in this checkout was extended by hand with the new settings because `setup:env` refuses to overwrite it; new clones get them from `.env.example`.
- **M3 readiness:** the API has sessions, the account endpoint and the ledger module behind Nest services. The first non-ledger CRUD table (watchlists) brings Prisma, introspected from the plain-SQL schema (D-43). Module boundaries for `ledger` are enforced by lint; add boundary rules for new modules as they appear.

M3 was not started.
