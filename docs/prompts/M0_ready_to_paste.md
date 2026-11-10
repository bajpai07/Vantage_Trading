> ENVIRONMENT NOTE: native Windows with PowerShell and Docker Desktop; repo at C:\dev\vantage (not in OneDrive); the 9 specs are in docs/specs; this is a brand-new repository; follow the WINDOWS RULES given in the chat. Do not touch any other folder.

# VANTAGE · Claude Code Prompt · M0 — FOUNDATION (small)

Paste this into Claude Code at the repository root. Put the 9 spec files in `docs/specs/` first and start Docker.

## 1. Goal

Create the smallest foundation that lets us start the ledger in M1: a monorepo, strict TypeScript, tests, a Postgres with correct roles, a SQL migration runner, a config guard, and one CI workflow. **No product code. No tables except extensions. No UI, no API routes, no auth.**

**Rules**
1. `docs/specs/` is the source of truth. If something is ambiguous or contradicts a spec, stop that task and report it. Do not invent decisions.
2. Inspect first. Never overwrite an existing file or delete what you did not create. If the repo already contains a project, stop and ask.
3. Do not build anything listed in §9. Simple beats clever.
4. Tool behaviour is a claim until you run it. Where §5 says "verify", run it and record the result.
5. Never print, log or commit secrets. Never put a secret on a command line.
6. Work on branch `phase/m0-foundation`. Small Conventional Commits. Do not push.
7. Never mark something passed unless you ran its command. Anything you could not run is **UNVERIFIED**, with the reason.

## 2. Inspect first

Run and read: `git status`, `git log -n 10`, `ls -la`, `cat package.json pnpm-workspace.yaml .nvmrc .gitignore` (if present), `node -v`, `pnpm -v`, `docker --version`, `docker compose version`, `docker info`. Specs must exist in `docs/specs/` (copy them in unmodified if they are elsewhere; if you cannot find all nine, ask). Read: ROADMAP (E0 and E1), ARCHITECTURE §1–2 and §9, DATABASE §1 and §12, and DECISIONS. Print a 10-line plan, then proceed.

## 3. Layout (create only this)

```
apps/api/                 # bare TypeScript entry; NestJS arrives in M2
packages/config/          # Zod config + guards
packages/money/           # EMPTY skeleton (logic in M1)
packages/test-utils/      # DB test helper
db/migrations/            # plain .sql files
infra/docker-compose.yml  infra/postgres/01-bootstrap.sh
tools/                    # setup-env.ts, migrate.mjs, cleanup-test-dbs.ts
docs/specs/  README.md  .env.example  .env.infra.example
.github/workflows/ci.yml
```
Do not create `engine`, `market-model`, `contracts`, other apps, or `apps/web`. They are created when needed. Record this as a deliberate deferral (§8).

## 4. Tasks (in order; commit after each)

**T1 · Repo and tooling.**
- Find the current **Active LTS Node** from the official release schedule; pin it in `.nvmrc` and `engines`. Pin pnpm via `packageManager`. Use **exact versions** for every dependency (`save-exact=true`; no `^`, `~` or `latest`).
- pnpm workspaces plus a minimal Turborepo for `build`, `typecheck` and `lint` only. Tests are not run through Turborepo.
- TypeScript strict (also `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`), ESM, project references.
- ESLint flat config plus Prettier. Add `.gitignore` (ignore `.env`, `.env.*` except the two `.example` files, `node_modules`, `dist`, `coverage`) and `.gitattributes` (`* text=auto eol=lf`).
- Vitest with two projects: `unit` (`*.test.ts`) and `integration` (`*.int.test.ts`). Workspace packages resolve to their `src` in tests.
- Money guard rules, as ESLint `no-restricted-syntax`/`no-restricted-imports`, applied to `packages/money/src` (and later `packages/engine/src`), tests excluded: ban `parseFloat`, `parseInt`, `Number(…)`, `Math.*`, decimal or exponent number literals (**hex like `0xE` must stay allowed**), `Date.now`, `new Date()` with no argument, `Math.random`, `performance.now`. Add one unit test using ESLint's `lintText` with a virtual path that proves each ban fires and that `0xE` and plain integers pass. (Money will use a Decimal library in M1; no escape hatch.)
- Done when: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:unit` pass.

**T2 · Config package** (`packages/config`, Zod).
- `loadConfig(env)` is pure and never reads `process.env`; `loadConfigFromProcess()` does. Variables: `APP_ENV` (`local|test|staging|production`), `LOG_LEVEL`, `DATABASE_URL`, `MARKET_DATA_SOURCE` (`FIXTURE|PROVIDER`; the real provider is chosen later).
- Guards, each with a unit test: (1) `FIXTURE` is refused in `staging` and `production`; (2) one aggregated error lists every bad variable **name and rule, never values**, and URL passwords are redacted (a test proves a known password never appears in any error); (3) the env must not contain `DATABASE_MIGRATOR_URL`, `POSTGRES_SUPERUSER_PASSWORD` or any `VANTAGE_*_PASSWORD`, and the `DATABASE_URL` user must not be `postgres` or `vantage_migrator` (apps never hold migration credentials).
- Export `buildTestEnv(overrides?)` from `@vantage/config/testing` for tests.
- `apps/api` entry: with `--check` it validates config only (no network, no DB), prints `{"app":"api","status":"config_ok"}` and exits 0; invalid config exits 2 with the redacted error on stderr; with no flag it prints a skeleton notice and exits 64.
- Done when: config unit tests pass, and a small script run with a replaced empty environment exits 2.

**T3 · Postgres and roles.**
- `infra/docker-compose.yml`: `postgres:16.x` (pinned tag), published only on `127.0.0.1:55432`, named volume, healthcheck, project name `vantage`. **No Redis.**
- **Verify first** with a throwaway container: files in `/docker-entrypoint-initdb.d` ending `.sql` get **no** environment-variable interpolation, `.sh` files can read env vars, and `psql` supports `\getenv`. If wrong, stop and report.
- `infra/postgres/01-bootstrap.sh` (executable, LF): `set -Eeuo pipefail`; fail if a needed variable is missing or starts with `change-me`; run `psql -v ON_ERROR_STOP=1` with a **quoted** here-document; load passwords with `\getenv` and use only as `:'var'`; `SET log_statement='none'`; create roles with `SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', …) WHERE NOT EXISTS (…) \gexec` (no dollar-quoted `DO` blocks). Roles: `vantage_migrator` (owns the database) and `vantage_app` (runtime). Database `vantage_dev OWNER vantage_migrator`.
- Hardening in `vantage_dev`: revoke all on the database and on schema `public` from PUBLIC; grant `CONNECT` and schema `USAGE` to `vantage_app`; `ALTER DEFAULT PRIVILEGES FOR ROLE vantage_migrator` revoke all on tables and sequences from PUBLIC. **No table grants to `vantage_app` in M0** (M1 grants explicitly).
- `tools/setup-env.ts` (`pnpm setup:env`) creates `.env` (application only: `APP_ENV=local`, `DATABASE_URL` as `vantage_app`) and `.env.infra` (superuser/migrator/app passwords and `DATABASE_MIGRATOR_URL`) from the `.example` files with random URL-safe secrets, mode `0600`. It **refuses to overwrite** either file and never prints secrets. Compose is always run with `--env-file .env.infra`, and uses `${VAR:?run pnpm setup:env}` for every secret.
- Scripts: `db:up` (`up -d --wait`), `db:down`, `db:reset` (`down -v`, with a note that init scripts run only on an empty volume).
- Done when: `pnpm setup:env && pnpm db:up` is healthy, a second `setup:env` refuses, and `docker inspect` shows the port bound to `127.0.0.1`.

**T4 · Migrations (plain SQL).**
- Use `node-pg-migrate` (pinned) through ONE wrapper, `tools/migrate.mjs`, which reads `DATABASE_MIGRATOR_URL` from the environment (`node --env-file=.env.infra`), never passes it on the command line, and allows only `up` and `status`. Options to use: migrations dir `db/migrations`, table `pgmigrations`, `--database-url-var DATABASE_MIGRATOR_URL`, `--no-single-transaction` (the default runs all migrations in one shared transaction), `--advisory-lock-mode wait`, `--check-order`, and an ignore pattern so a README in the folder is skipped.
- Files are `NNNN_name.sql`, forward-only (up marker only, no down section). **Verify by running, not by reading `--help`**, in a throwaway database, and write the observed results into `docs/migrations.md` (keep it to a short table): (a) the exact SQL marker syntax and that a multi-statement file with a `$$` function body applies; (b) migration 2 = a good statement then a failing one: migration 1 stays applied, migration 2 is fully rolled back and not recorded (and note that without `--no-single-transaction` both would roll back); (c) two concurrent runs on a migration containing `pg_sleep` both exit 0 and apply it exactly once; (d) `0002` runs before `0010`, and the README is ignored. If any fails, stop and report options.
- Baseline `db/migrations/0001_extensions.sql`: `CREATE EXTENSION IF NOT EXISTS citext;` and `pg_trgm;` only. Verify `vantage_migrator` can create them without superuser.
- Scripts: `db:migrate`, `db:status`.
- Done when: `db:migrate` applies 0001, a second run is a no-op, `db:status` shows it.

**T5 · Integration test helper** (`packages/test-utils`, uses `pg`).
- `createTestDatabase()`: using the superuser from `.env.infra`, create an empty database `t_<random>` owned by `vantage_migrator`, apply the same database-level hardening as the bootstrap, run the migration wrapper against it, and return pools for `app` and `migrator` plus `dispose()`. `dispose()` ends the pools (with a timeout) and runs `DROP DATABASE … WITH (FORCE)`, is idempotent, and always runs in `afterAll`/`finally`. If setup fails after the database exists, drop it and rethrow.
- `pnpm test:cleanup` drops stale `t_*` databases. Tests never read or write `vantage_dev`.
- Integration tests (`*.int.test.ts`), each a pair of "must fail" and "control succeeds":
  1. Fresh test database is migrated (`citext` exists) and two test databases are isolated.
  2. `vantage_app` connects over TCP; a wrong password fails.
  3. `vantage_app` has no superuser/createdb/createrole and is a member of no other role.
  4. `vantage_app` cannot `CREATE TABLE`; the migrator can (control).
  5. A migrator-created table is unreadable by `vantage_app`; after `GRANT SELECT` it is readable (control); `INSERT` is still denied.
  6. A failing test body still disposes its database (assert the database is gone), and `dispose()` with an open busy connection completes.
- Done when: `pnpm test:integration` passes twice in a row and leaves no `t_*` databases.

**T6 · CI and docs.**
- One workflow, `pull_request` and pushes to `main` (never `pull_request_target`; `permissions: contents: read`; pinned runner image; Node from `.nvmrc`). Steps are the same scripts you run locally: install `--frozen-lockfile`, `setup:env`, `db:up`, `db:migrate`, then `verify`. Pin actions to a verified full SHA, or to a major tag if you cannot verify (say which in the report).
- `README.md`: what VANTAGE is, the line "virtual money, not a brokerage", quickstart, the layout, and these rules: money is decimal and never a float; PostgreSQL is the source of truth for money; no real-money trading, broker routing, margin, leverage or shorting; no fake data presented as real; apps never hold migration credentials.
- Append rows to the `docs/specs/DECISIONS.md` table, **without editing any existing line** (insert before the `## Open assumptions` heading; verify `git diff --numstat` shows 0 deletions). Mark each `APPROVED by founder (M0)`: D-29 one-process modular monolith first; D-30 synchronous market-order execution (mandatory: one atomic transaction, account-level locking, idempotency, full validation); D-31 multi-currency schema with USD-only balances and trading in the first MVP; D-32 ETFs use the same pipeline as stocks; D-33 whole shares in the MVP (TRADING_ENGINE §1: fractional off, flag-controlled later; the instrument has `fractional_ok`); D-34 stack unchanged (NestJS, Prisma for non-ledger tables, raw SQL for the ledger, Next.js); D-35 plain-SQL forward-only migrations via node-pg-migrate; D-36 two env files, apps never get migration credentials; D-37 layout deferral (§3).

## 5. Scripts and verification

Root scripts: `build`, `typecheck`, `lint`, `format:check`, `test:unit`, `test:integration`, `setup:env`, `db:up`, `db:down`, `db:reset`, `db:migrate`, `db:status`, `test:cleanup`, and `verify` = `format:check`, `lint`, `typecheck`, `build`, `test:unit`, `test:integration`.

Verify on a **clean clone** of the committed branch (`git clone --no-hardlinks . "$(mktemp -d)"`; stop the original's database first because the port is shared):
```bash
pnpm install --frozen-lockfile
pnpm setup:env && pnpm db:up
pnpm db:migrate && pnpm db:migrate && pnpm db:status
pnpm verify
pnpm test:integration          # second consecutive run
node apps/api/dist/main.js --check   # with a valid test env: exit 0; with an empty env: exit 2
pnpm db:down
```

## 6. Acceptance criteria (run each, report PASS / FAIL / UNVERIFIED)

1. Clean clone to green in under 10 minutes with images already pulled.
2. All dependency versions are exact; `.nvmrc`, `engines` and `packageManager` agree.
3. The lint test proves every money-guard ban fires, and `0xE` is allowed.
4. Config guards pass, including FIXTURE-in-production, redaction and migrator-credential rejection.
5. `--check` exits 0, 2 and 64 as specified, with no DB and no env file needed.
6. `setup:env` creates two 0600 files, and refuses to overwrite.
7. Postgres is healthy, bound to loopback only, and the roles are created by the `.sh` bootstrap with no default or literal passwords anywhere in git.
8. Migration experiments (a)–(d) recorded and passing; `db:migrate` is idempotent.
9. All six integration tests pass twice in a row, with no leftover `t_*` databases.
10. CI workflow exists and uses the same scripts (executed by CI? say so only if it ran).
11. Specs are unchanged except the appended decision rows (0 deletions).
12. `git status` is clean and no `.env*` file other than the two `.example` files is tracked.

## 7. Edge cases to handle
Docker not running (mark Docker tasks UNVERIFIED, never fake); port 55432 in use (report; do not change silently); bootstrap edited after first start (needs `db:reset`); CRLF in `.sh` or `.sql` files (enforced by `.gitattributes`); special characters in passwords (secrets are URL-safe; the bootstrap quotes anyway).

## 8. Common mistakes
Floats for money; unpinned versions; secrets in git, logs or process arguments; expecting `${VAR}` inside a mounted `.sql` file; testing roles over the container's unix socket (it uses `trust`, so use TCP); a "must fail" test with no "control succeeds" partner; running migrations as superuser or `vantage_app`; touching `vantage_dev` from tests; adding NestJS, Prisma, Next.js, Redis or any M1+ table; editing spec text to fit the code.

## 9. Out of scope for M0 (do not build)
Any table, enum, trigger or grant beyond the roles above; money or decimal logic; NestJS, Prisma, Next.js, Redis; auth; market data; API routes; UI; Testcontainers; dependency-cruiser; replay or recorder tools; schema snapshots; git hooks; gitleaks, dependabot, actionlint; a Windows or timezone matrix.

## 10. Final report (write to `docs/phase-reports/M0-report.md` and print)
1. Status: READY / READY WITH CAVEATS / NOT READY for M1, in at most 5 lines.
2. Versions used (Node, pnpm, TypeScript, Vitest, ESLint, node-pg-migrate, pg, Postgres image) and how each was verified.
3. Tool-fact results: init-script interpolation, `\getenv`, extension creation by the migrator, migration experiments (a)–(d).
4. Task status T1–T6: DONE / PARTIAL / NOT DONE / UNVERIFIED.
5. Files created and any pre-existing files you modified.
6. Commands run with exit code and duration; paste failing output verbatim.
7. Acceptance table (the 12 items above).
8. Deviations, surprises, spec questions (stop-and-report format).
9. Known limitations and manual founder actions (for example, GitHub branch protection).
10. M1 readiness: the test helper is ready for ledger tests; `vantage_app` has no grants; the migration wrapper is ready for ledger SQL.

Do not start M1. Stop after the report.
