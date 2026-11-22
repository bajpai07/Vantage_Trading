# Running VANTAGE with Docker (M10)

One command starts the whole demo: Postgres 16, the one-shot database migrations, the API and the web app. Prices are simulated and the money is virtual; see [the About page](../apps/web/src/app/about/page.tsx) and [FACTS](FACTS.md).

## Requirements

Docker with Compose v2 (Docker Desktop on Windows or macOS, or Docker Engine on Linux) and Node 22.19.0 with pnpm 10.28.2 only for the two helper scripts. No other tool is needed to run the stack.

## Run it

```powershell
pnpm install --frozen-lockfile        # once, for the helper scripts
pnpm compose:setup                    # once: writes the untracked .env.compose with random secrets (never printed)
docker compose --env-file .env.compose up --build
```

Open http://localhost:3000. The stack uses the simulated market (stocks, ETFs and crypto, open around the clock), the matcher is on, and the "Try the demo" button is on. Stop it with `Ctrl+C`, or `docker compose --env-file .env.compose down` (the data stays in the named volume `vantage-demo_vantage_demo_pgdata`).

## What runs

| Service    | Image target                        | Published               | Notes                                                                                                                      |
| ---------- | ----------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `postgres` | `postgres:16.15` (pinned by digest) | **no**                  | named volume, healthcheck, roles created by `infra/postgres/01-bootstrap.sh`                                               |
| `migrate`  | `Dockerfile` target `migrate`       | no                      | one-shot: runs the forward-only migrations as `vantage_migrator`, then exits 0                                             |
| `api`      | target `api`                        | **no**                  | runs as `vantage_app`, waits for a healthy database and a finished `migrate`; health check `GET /health`                   |
| `web`      | target `web`                        | `127.0.0.1:${WEB_PORT}` | same-origin proxy: the browser only ever talks to the web app, which forwards `/api/*` to the API over the compose network |

All containers run as the non-root user `node`. No secret is built into an image: `.dockerignore` keeps every `.env*` file out of the build context. Secrets are passed as environment variables by Compose from the untracked `.env.compose`.

## Ports

Only the web port is published, and only on `127.0.0.1`. The default is `3000`; change `WEB_PORT` in `.env.compose`. On Windows, some ports are reserved by the system and Docker cannot bind them ("An attempt was made to access a socket in a way forbidden by its access permissions" or "ports are not available"). List them and pick a port outside every range:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

The ranges change after reboots and updates, so check again if a port that worked yesterday fails today.

## Resetting, logs, shell

```powershell
docker compose --env-file .env.compose down -v          # also deletes the database volume (a clean start)
docker compose --env-file .env.compose logs -f api      # follow the API log (JSON lines, no secrets)
docker compose --env-file .env.compose ps              # health of every service
docker compose --env-file .env.compose run --rm migrate # run the migrations again (a no-op when up to date)
```

If you regenerate the secrets with `pnpm compose:setup --force`, run `down -v` first: the Postgres volume keeps the passwords it was created with.

## Smoke test

`pnpm compose:smoke` builds and starts the stack under its **own project name** (`vantage-smoke`, web port 3555, a temporary loopback mapping of Postgres on 56555 for this run only), registers a user over HTTP, places a market order and a resting limit order, reads the portfolio, checks the equity identity from the response strings, runs the ledger reconcile check (invariants I1 to I7 and I10) against the compose database, and always tears everything down (`down -v`). It exits 0 on success and 1 otherwise, and never touches your normal dev database or any other container. Change the ports with `SMOKE_WEB_PORT` and `SMOKE_DB_PORT` if they clash.

## Troubleshooting

- **`run pnpm compose:setup`**: the three passwords are missing; run the setup script.
- **The `web` container is "unhealthy" for the first 30 seconds**: the Next server needs a moment; the health check retries.
- **Port already allocated**: another program (or another VANTAGE stack) uses `WEB_PORT`.
- **A browser shows a login page whose requests fail**: the API container did not start; read `docker compose logs api`. A wrong configuration is reported with the variable names (never the values) and exit code 2.
- **`docker stop` / `docker compose down`**: the API logs `shutting down`, closes its database pool and exits 0 within the grace period (15 s).

## Image facts (M10)

- Base image: `node:22.19.0-bookworm-slim`, pinned by tag **and** digest (`sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90`); Postgres `postgres:16.15` pinned by digest (`sha256:65b16a8b326e0cfbdf33fa7e783f2a0cb352a61448616ccccfd616ef42aa0f65`).
- Sizes: `api` 366 MB, `web` 926 MB, `migrate` 340 MB (the web image carries Next.js and its compiler binary).
- **Licences:** Next's optional image-optimisation binary (`@img/sharp-*` with libvips, LGPL) is deleted in the build stage and the build fails if anything with that name is left; `next.config.ts` sets `images.unoptimized` and the app never uses `next/image` (D-116).
- The `web` container exits with code 143 on `docker stop` (Node's default for SIGTERM; the web app holds no state). The `api` container logs `shutting down` and exits 0.
