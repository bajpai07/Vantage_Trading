# VANTAGE

VANTAGE is a trading-practice platform: **virtual money, not a brokerage.** Users trade with a simulated cash balance against market data. Nothing here moves real money.

This repository is at milestone **M0 (foundation)**: tooling, a Postgres with correct roles, a SQL migration runner, a config guard and CI. There is no product code yet. The specifications are in [docs/specs](docs/specs).

## Rules

- Money is decimal and never a float.
- PostgreSQL is the source of truth for money.
- No real-money trading, broker routing, margin, leverage or shorting.
- No fake data presented as real.
- Apps never hold migration credentials.

## Quickstart

Requirements: Node 22.19.0 (see `.nvmrc`), pnpm 10.28.2, Docker (with Compose).

```bash
pnpm install --frozen-lockfile
pnpm setup:env          # creates .env and .env.infra with random secrets; refuses to overwrite
pnpm db:up              # Postgres 16 on 127.0.0.1 only
pnpm db:migrate
pnpm verify             # format, lint, typecheck, build, unit and integration tests
pnpm db:down
```

### Start the API locally

```bash
pnpm build
node --env-file=.env apps/api/dist/main.js         # serves on http://127.0.0.1:3000
node --env-file=.env apps/api/dist/main.js --check # validate configuration only
```

`.env` (created by `pnpm setup:env` from `.env.example`) must contain `WEB_ORIGIN`, the single origin that CORS and the CSRF check accept (for example `http://localhost:3000`). `COOKIE_SECURE=false` is allowed only when `APP_ENV` is `local` or `test`. If your `.env` was created before M2, add `WEB_ORIGIN` and `COOKIE_SECURE` by hand (see `.env.example`). Endpoints and rules are in [docs/api.md](docs/api.md).

### The Postgres host port is configurable

The default host port is **55432**, set by `POSTGRES_HOST_PORT` in `.env.infra.example`. If it is busy on your machine, `pnpm setup:env` stops with a clear message and writes nothing; choose a free one with `pnpm setup:env --port 55433`. The port is then written into `.env.infra` (and into the `DATABASE_URL` and `DATABASE_MIGRATOR_URL` values), and the compose file, the migration wrapper, the test helper and all scripts read it from there. Nothing hard-codes a port.

### Two env files

- `.env` is for applications: `APP_ENV`, `LOG_LEVEL`, `DATABASE_URL` (as `vantage_app`), `MARKET_DATA_SOURCE`.
- `.env.infra` is for infrastructure and migrations: superuser, migrator and app passwords, `DATABASE_MIGRATOR_URL`. Never give it to an application.

Neither is committed. Only `.env.example` and `.env.infra.example` are tracked. File mode 0600 is applied where the file system supports it (not on Windows).

## Local and test quotes are FIXTURE data

Until a real data vendor is connected (M3b), every quote, instrument price and market snapshot in `local` and `test` is **synthetic FIXTURE data**: real company names with obviously fake prices (multiples of 11.11), labelled `source: "FIXTURE"` in the database, the API and the logs. It is never real market data. The app refuses to start in staging or production if fixture data is present, and `MARKET_DATA_SOURCE=PROVIDER` exits with "no provider adapter installed; M3b". See [docs/market-data.md](docs/market-data.md).

## Layout

```
apps/api/                 NestJS API (auth, account, ledger, health); `--check` validates config
packages/config/          Zod config and guards
packages/contracts/       Zod request/response schemas shared with the web app
packages/engine/          pure posting recipes (no IO)
packages/market-model/    pure freshness, quote validation and exchange calendars
packages/money/           empty skeleton (logic in M1) with lint rules that ban float-style code
packages/test-utils/      database test helper
db/migrations/            plain forward-only .sql files
infra/                    docker-compose.yml, postgres/01-bootstrap.sh
tools/                    setup-env.ts, migrate.mjs, cleanup-test-dbs.ts
docs/                     specs, prompts, migration notes, phase reports
```

`engine`, `market-model`, `contracts`, other apps and `apps/web` are deliberately not created yet.

## Notes

- Migrations: see [docs/migrations.md](docs/migrations.md).
- **Follow-up:** upgrade to the current Active LTS Node before closed beta (change `.nvmrc`, `engines`, and CI reads `.nvmrc`; then re-run `pnpm verify`). Node 22.19.0 is pinned for now because it is the version the M0 results were verified on.
