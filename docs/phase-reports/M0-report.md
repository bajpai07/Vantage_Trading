# M0 report — Foundation

Branch `phase/m0-foundation` (not pushed). Run date 2026-11-10, native Windows 11, PowerShell/Git Bash, Docker Desktop.

## 1. Status

**READY WITH CAVEATS for M1.**

- Everything in T1–T6 was built and verified by running it on a clean clone (84 s, images already pulled).
- Two approved deviations: Node 22.19.0 instead of Active LTS, and host port 55433 (configurable) instead of 55432.
- UNVERIFIED: file mode 0600 (Windows), and the CI workflow has never executed (nothing was pushed).
- Manual founder actions are listed in section 9.

## 2. Versions used

| Item            | Version                                                | How verified                                                                                             |
| --------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Node            | 22.19.0                                                | `node -v` on the machine; `.nvmrc` = `engines.node` = 22.19.0 (checked by script in clean clone)         |
| pnpm            | 10.28.2                                                | `pnpm -v`; pinned in `packageManager`                                                                    |
| TypeScript      | 6.0.3                                                  | `pnpm ls`; see deviations (7.0.2 is the npm latest, but typescript-eslint 8.72.2 only supports `<6.1.0`) |
| Vitest          | 5.1.0                                                  | `pnpm ls`; unit and integration runs                                                                     |
| ESLint          | 10.14.0 (+ typescript-eslint 8.72.2)                   | `pnpm ls`; `pnpm lint` green                                                                             |
| node-pg-migrate | 9.0.0                                                  | `pnpm ls`; migration experiments run against it                                                          |
| pg              | 8.23.1                                                 | `pnpm ls`; used by integration tests                                                                     |
| Postgres image  | `postgres:16.15`                                       | tag pinned in compose; container reached `healthy`. 16.15 is the newest 16.x tag on Docker Hub today     |
| Others          | zod 4.6.7, prettier 3.9.10, turbo 2.11.10, tsx 4.23.15 | `pnpm ls`; all dependency versions are exact (script check: 0 non-exact)                                 |

## 3. Tool-fact results

| Fact                                                              | Result                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.sql` in `/docker-entrypoint-initdb.d` gets no env interpolation | Confirmed (throwaway container printed the literal `$PROBEVAR`).                                                                                                                                                                                                                                            |
| `.sh` init files read env vars                                    | Confirmed (`PROBEVAR` visible).                                                                                                                                                                                                                                                                             |
| `psql` supports `\getenv`                                         | Confirmed (value loaded).                                                                                                                                                                                                                                                                                   |
| Bootstrap runs on Windows bind mount                              | Docker Desktop shows the mounted file as `-rwxrwxrwx`, so the image **ran** it (log: `running ...01-bootstrap.sh`). Roles and database created.                                                                                                                                                             |
| Bootstrap runs when NOT executable                                | Tested with a copy at mode 644: the image **sourced** it (`sourcing ...`); `set -Eeuo pipefail` and the here-document worked; roles and database created.                                                                                                                                                   |
| Migrator creates `citext` and `pg_trgm` without superuser         | Confirmed: `0001_extensions` applied by `vantage_migrator` (`rolsuper = f`); both extensions are owned by it.                                                                                                                                                                                               |
| Migration experiments (a)–(d)                                     | All pass. Full table in [docs/migrations.md](../migrations.md). Summary: marker is `-- Up Migration`; failing 0002 rolled back, 0001 kept (default single-transaction mode would roll back both, verified, exit 1); two concurrent runs both exit 0 and apply once; order is numeric and README is ignored. |

## 4. Task status

| Task                  | Status  | Note                                                                                                       |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| T1 Repo and tooling   | DONE    | 17 lint-guard tests prove every ban fires and `0xE` and integers pass.                                     |
| T2 Config package     | DONE    | 3 guards tested; `--check` exits 0, 2, 64 (also run as a real child process with an empty environment).    |
| T3 Postgres and roles | DONE    | Healthy, bound to `127.0.0.1:55433`, second `setup:env` refuses, busy port stops. 0600 UNVERIFIED (see 7). |
| T4 Migrations         | DONE    | `db:migrate` twice (second is a no-op), `db:status` shows 0001.                                            |
| T5 Test helper        | DONE    | 11 integration tests (six required groups plus controls) pass twice in a row; 0 leftover `t_*` databases.  |
| T6 CI and docs        | PARTIAL | Workflow written, README, decisions D-29..D-37 added (0 deletions). Workflow not executed (UNVERIFIED).    |

## 5. Files

Created (all new, nothing pre-existing modified except the spec rows below):
`.gitattributes`, `.gitignore`, `.npmrc`, `.nvmrc`, `.prettierrc.json`, `.prettierignore`, `.env.example`, `.env.infra.example`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `README.md`, `.github/workflows/ci.yml`, `infra/docker-compose.yml`, `infra/postgres/01-bootstrap.sh`, `db/migrations/0001_extensions.sql`, `db/migrations/README.md`, `docs/migrations.md`, `docs/phase-reports/M0-report.md`, `tools/setup-env.ts`, `tools/migrate.mjs`, `tools/cleanup-test-dbs.ts`, `tools/line-endings.test.ts`, `apps/api/*` (package.json, 2 tsconfigs, `src/run.ts`, `src/main.ts`, `src/api.test.ts`), `packages/config/*` (src `index.ts`, `testing.ts`, `config.test.ts`), `packages/money/*` (empty `index.ts`, `money-guard.test.ts`), `packages/test-utils/*` (src `index.ts`, `test-utils.int.test.ts`).

Modified: `docs/specs/DECISIONS.md` (9 rows added, 0 deletions, verified with `git diff --numstat`: `9 0`). `docs/prompts/M0_ready_to_paste.md` had its ENVIRONMENT NOTE replaced in the setup step, as instructed.

Not tracked (by design): `.env`, `.env.infra`.

## 6. Commands run (exit code, approximate duration)

| Command                                                                                 | Exit                | Time     |
| --------------------------------------------------------------------------------------- | ------------------- | -------- |
| `node -v`, `git --version`, `docker --version`, `docker compose version`, `docker info` | 0                   | < 5 s    |
| Clean clone: `pnpm install --frozen-lockfile`                                           | 0                   | 10 s     |
| `pnpm setup:env --port 55433` (then a second run)                                       | 0 (then 1: refuses) | 1 s      |
| `pnpm db:up`                                                                            | 0                   | 11 s     |
| `pnpm db:migrate` (twice), `pnpm db:status`                                             | 0, 0, 0             | 2 s, 1 s |
| `pnpm verify` (format, lint, typecheck, build, unit 32 tests, integration 11 tests)     | 0                   | 45 s     |
| `pnpm test:integration` (second consecutive run)                                        | 0                   | 13 s     |
| `node apps/api/dist/main.js --check` valid env / empty env / no flag                    | 0 / 2 / 64          | < 1 s    |
| `pnpm db:down`                                                                          | 0                   | 2 s      |

Clean-clone total: **84 s** (acceptance limit 10 min).

Failures met along the way (all fixed, none hidden):

1. Download of the Node 26 zip was denied by the permission classifier; replaced by the approved Node 22.19.0 decision.
2. First `pnpm format:check` listed 4 unformatted files; fixed with Prettier.
3. First integration run: `Vitest caught 1 unhandled error ... Error: Connection terminated unexpectedly` (the deliberately killed busy connection had no `error` listener); fixed in the test, then 2 consecutive clean runs.
4. A first version of my wrapper-comparison experiment used a mis-escaped ignore pattern and wrongly showed "exit 0, nothing applied" for the single-transaction case. Re-run correctly: exit 1, both migrations rolled back.

## 7. Acceptance table

| #   | Criterion                                                                 | Result                                   | Evidence                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Clean clone to green in under 10 minutes                                  | PASS                                     | 84 s total on a `git clone --no-hardlinks` of the branch.                                                                                                                                           |
| 2   | Exact dependency versions; `.nvmrc`, `engines`, `packageManager` agree    | PASS                                     | Script: 0 non-exact; `.nvmrc` 22.19.0 = `engines.node` 22.19.0; `packageManager` pnpm@10.28.2 = `pnpm -v`; node -v 22.19.0.                                                                         |
| 3   | Lint test proves each ban fires; `0xE` allowed                            | PASS                                     | `packages/money/src/money-guard.test.ts`, 17 tests green.                                                                                                                                           |
| 4   | Config guards                                                             | PASS                                     | `config.test.ts` (FIXTURE in staging/production, redaction with a random password, migrator credentials and users rejected).                                                                        |
| 5   | `--check` exits 0, 2, 64 with no DB or env file                           | PASS                                     | Run on built `dist/main.js` in the clean clone, and as child processes in unit tests.                                                                                                               |
| 6   | `setup:env` creates two 0600 files and refuses to overwrite               | **UNVERIFIED (partly)**                  | Creation and refusal PASS (run twice). Mode 0600 cannot be enforced or checked on Windows file systems: UNVERIFIED.                                                                                 |
| 7   | Healthy, loopback only, roles from the `.sh`, no literal passwords in git | PASS                                     | `docker inspect`: `{"HostIp":"127.0.0.1","HostPort":"55433"}`; log `running ...01-bootstrap.sh`; `change-me` appears only in the two `.example` files, the bootstrap guard and the prompt text.     |
| 8   | Migration experiments (a)–(d); `db:migrate` idempotent                    | PASS                                     | `docs/migrations.md`; second `db:migrate` printed "No migrations to run!".                                                                                                                          |
| 9   | Six integration tests pass twice, no leftover `t_*`                       | PASS                                     | Two consecutive runs of 11 tests green; leftover count 0 after each.                                                                                                                                |
| 10  | CI workflow exists and uses the same scripts                              | PASS (exists); **UNVERIFIED (executed)** | `.github/workflows/ci.yml`. It has never run: nothing was pushed. Actions pinned to full SHAs resolved from the public release tags (checkout v7.0.1, setup-node v7.1.0, pnpm/action-setup v6.1.1). |
| 11  | Specs unchanged except appended decision rows                             | PASS                                     | `git diff --numstat b24d259 HEAD -- docs/specs` = `9 0 docs/specs/DECISIONS.md`.                                                                                                                    |
| 12  | `git status` clean; no `.env*` tracked except the examples                | PASS                                     | `git status --short` empty; tracked: `.env.example`, `.env.infra.example` only.                                                                                                                     |

## 8. Deviations, surprises, spec questions

**Approved deviations**

1. **Node 22.19.0 instead of Active LTS.** Reason: the installed runtime is 22.19.0 and all results must be verified on the pinned version. Node 22 is in Maintenance with security updates. Node 26 is newly LTS (entered 2026-10-28) and ecosystem support is unproven. Follow-up recorded in README: upgrade to the current Active LTS before closed beta (change `.nvmrc`, `engines`; CI reads `.nvmrc`; re-run `verify`).
2. **Postgres host port 55433 on this machine instead of 55432.** Reason: `finsight-postgres-1` already uses 55432 (finsight containers were not touched). The port is now configurable: `POSTGRES_HOST_PORT` in `.env.infra.example` (default 55432); `setup:env` writes the chosen value (`--port`) into `.env.infra` and into both database URLs, and stops with a clear message if the port is busy. The compose file, `DATABASE_URL`, `DATABASE_MIGRATOR_URL`, the test helper and scripts read it from the env files. Compose project name is `vantage`.

**Other deviations and surprises**

3. **TypeScript 6.0.3**, not the npm latest 7.0.2, because typescript-eslint 8.72.2 declares `typescript >=4.8.4 <6.1.0`. No stop needed; revisit when typescript-eslint supports 7.
4. `node-pg-migrate` has no `status` command, so `status` in `tools/migrate.mjs` compares the files with the `pgmigrations` table. The wrapper also accepts `VANTAGE_MIGRATIONS_DIR`, used only for experiments and tests.
5. `.gitattributes` was committed with the first docs commit (needed so line endings are LF from the start); T1 later re-wrote it with the same effect.
6. The DECISIONS table has no Status column, so "APPROVED by founder (M0)" is written at the end of the last column ("Trade-off / risk") of each new row.
7. pnpm 10 blocked esbuild's postinstall script ("Ignored build scripts: esbuild"). Not needed: tsx and Vitest work (all tests pass).
8. The turbo CLI prints a telemetry notice; telemetry was not changed on your machine.
9. Clean-clone verification needed the shared compose project name, so the original local database volume was removed (`down -v`) and recreated by the clone. It held only the two extensions. The clone's stack was brought down at the end; the original stack is currently **down** (`pnpm db:up && pnpm db:migrate` to restore it).

**Spec questions (not blocking, not decided by me)**

- DATABASE §12 and D-15 describe Prisma Migrate for tables with hand-written SQL beside it; D-35 (approved in M0) says plain forward-only SQL through node-pg-migrate. Prisma arrives in M2, so please confirm that D-35 supersedes the Prisma Migrate wording for ledger and non-ledger tables.
- ROADMAP E0 lists Redis, Testcontainers, secret scan, import-boundary lint, and provider spike scripts. The M0 prompt §9 defers all of them. They remain unscheduled.

## 9. Known limitations and manual founder actions

- 0600 is not enforceable on Windows; `.env.infra` holds the superuser password. Keep the repo outside synced folders and restrict the folder permissions yourself if the machine is shared.
- The CI workflow has not run. After the first push, check that it passes on `ubuntu-24.04` (the default port 55432 is free on runners).
- Configure GitHub branch protection on `main` (require CI, require review) and enable secret scanning and Dependabot; both were out of scope for M0.
- Actions are pinned by SHA that I resolved from the public GitHub API (unauthenticated); re-verify them when you first push.
- Postgres init scripts run only on an empty volume: after editing `01-bootstrap.sh`, run `pnpm db:reset`.
- Integration tests need `.env.infra` and a running database; `test:cleanup` drops every database named `t_` plus 12 hex characters, so do not run it while another test run is in progress.
- Upgrade Node to the current Active LTS before closed beta (see deviation 1).

## 10. M1 readiness

- The test helper `createTestDatabase()` is ready for ledger tests: it makes an isolated, hardened, migrated database per suite and always drops it.
- `vantage_app` has no table grants; M1 migrations must grant explicitly, and the helper's tests show the pattern (deny, `GRANT`, control).
- `tools/migrate.mjs` is ready for ledger SQL (forward-only, `-- Up Migration` marker, one transaction per file, `--check-order` on).
- Money guard lint rules apply to `packages/money/src` and are already configured for `packages/engine/src`.

M1 was not started.

## Windows notes

- **Docker bind mount:** the `.sh` mounted from Windows appears with mode 777, so the image executes it; it was also tested at mode 644 (sourced) and works either way.
- **File mode 0600:** cannot be applied or checked; marked UNVERIFIED.
- **Line endings:** `.gitattributes` enforces LF; a test asserts the bootstrap script and migrations contain no `\r`.
- **Console encoding:** PowerShell 5.1 shows the UTF-8 "·" and "—" in specs as mojibake; the files themselves are intact UTF-8.
- **Git Bash path mangling:** `docker exec ... ls /docker-entrypoint-initdb.d` needed `MSYS_NO_PATHCONV=1`.
- **Ports:** Docker Desktop's backend process owns published ports, so a bind test on `127.0.0.1` is how `setup:env` detects a busy port; it correctly detected the finsight container on 55432.
- **Scripts:** all repo scripts are Node/TypeScript (`tsx`); only the bootstrap is `.sh`, and it runs in the Linux container.
- **Shell escaping:** a regex written through a shell heredoc lost a backslash once (see failure 4); pattern strings now live in Write-created files.
