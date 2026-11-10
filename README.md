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

### The Postgres host port is configurable

The default host port is **55432**, set by `POSTGRES_HOST_PORT` in `.env.infra.example`. If it is busy on your machine, `pnpm setup:env` stops with a clear message and writes nothing; choose a free one with `pnpm setup:env --port 55433`. The port is then written into `.env.infra` (and into the `DATABASE_URL` and `DATABASE_MIGRATOR_URL` values), and the compose file, the migration wrapper, the test helper and all scripts read it from there. Nothing hard-codes a port.

### Two env files

- `.env` is for applications: `APP_ENV`, `LOG_LEVEL`, `DATABASE_URL` (as `vantage_app`), `MARKET_DATA_SOURCE`.
- `.env.infra` is for infrastructure and migrations: superuser, migrator and app passwords, `DATABASE_MIGRATOR_URL`. Never give it to an application.

Neither is committed. Only `.env.example` and `.env.infra.example` are tracked. File mode 0600 is applied where the file system supports it (not on Windows).

## Layout

```
apps/api/                 bare TypeScript entry (NestJS arrives in M2); `--check` validates config
packages/config/          Zod config and guards
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
