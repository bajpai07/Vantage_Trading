# syntax=docker/dockerfile:1.7
# VANTAGE container images (M10, D-110): one multi-stage file, three runtime targets: `api`, `web` and `migrate`.
#   docker build --target api  -t vantage-api  .
#   docker build --target web  -t vantage-web  .
#   docker build --target migrate -t vantage-migrate .
# No secret is used at build time: nothing is read from the environment and no .env file is copied (see .dockerignore).
# Base image: Node 22.19.0 on Debian bookworm-slim, pinned by tag AND digest (the digest was read with `docker image inspect`).
ARG NODE_IMAGE=node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

# ---- base: Node and the pinned pnpm (the version of package.json "packageManager") -------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

# ---- build: all dependencies from the lockfile, then compile every workspace package ----------------------------------------
FROM base AS build
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/pnpm/store,id=pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
RUN pnpm turbo run build --filter=@vantage/api... --filter=web...
# Self-contained, production-only copies of the three deployables (pnpm deploy resolves the workspace packages).
RUN pnpm --filter @vantage/api deploy --prod --legacy /out/api \
 && pnpm --filter web deploy --prod --legacy /out/web \
 && pnpm --filter @vantage/migrate-runner deploy --prod --legacy /out/migrate
# The web app: the production build, the config the Next config file imports, and nothing else.
RUN mkdir -p /out/web/src/lib \
 && cp -r apps/web/.next /out/web/.next \
 && cp apps/web/next.config.ts apps/web/tsconfig.json /out/web/ \
 && cp apps/web/src/lib/config.ts /out/web/src/lib/config.ts \
 && mkdir -p /out/migrate/tools /out/migrate/db \
 && cp tools/migrate.mjs /out/migrate/tools/migrate.mjs \
 && cp -r db/migrations /out/migrate/db/migrations
# The optional image-optimisation binary of Next (@img/sharp-*, with libvips: LGPL) is never used by VANTAGE (next.config sets
# images.unoptimized and there is no next/image) and is NOT shipped (D-116). It is deleted here, wherever pnpm hoisted it, and the
# build FAILS if anything with that name is left. The build cache of Next is not needed at run time either.
RUN for pass in 1 2 3 ; do \
      find /out \( -iname '*sharp*' -o -iname '*libvips*' -o -name '@img' \) -print0 | xargs -0 -r rm -rf ; \
    done ; \
    rm -rf /out/web/.next/cache ; \
    left="$(find /out \( -iname '*sharp*' -o -iname '*libvips*' -o -name '@img' \) | head -5)" ; \
    if [ -n "$left" ] ; then echo "sharp is still in the image: $left" ; exit 1 ; fi

# ---- api ---------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/api /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# node is PID 1, so `docker stop` (SIGTERM) reaches the app: it logs the shutdown and exits 0
CMD ["node", "dist/main.js"]

# ---- web ---------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /out/web /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]

# ---- migrate (one-shot) ------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/migrate /app
USER node
# DATABASE_MIGRATOR_URL comes from the environment of the compose service (never from the image)
CMD ["node", "tools/migrate.mjs", "up"]
