# Migrations

This folder holds forward-only plain SQL files named `NNNN_name.sql`. The runner is `tools/migrate.mjs` (only `up` and `status`).
The file `README.md` is ignored by the runner. Migrations are never edited after they are applied.
