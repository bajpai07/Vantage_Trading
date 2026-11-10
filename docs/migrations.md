# Migrations (observed behaviour)

Runner: `tools/migrate.mjs` wrapping `node-pg-migrate` 9.0.0. Options: dir `db/migrations`, table `pgmigrations`,
`--database-url-var DATABASE_MIGRATOR_URL`, `--no-single-transaction`, `--advisory-lock-mode wait`, `--check-order`,
ignore pattern `(^\..*)|(\.md$)`. Files are `NNNN_name.sql`, forward-only.

Every row below was observed by running the wrapper against throwaway databases (Postgres 16.15, 2026-11-10).

| #   | Experiment                                                                                                                                       | Observed                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | File starting with the marker line `-- Up Migration`, with two tables, a `$$` plpgsql function body containing a `;`, and an insert in one file. | Exit 0. Both tables exist, the function returns 42, one row recorded in `pgmigrations`. The marker is exactly `-- Up Migration`. A file with no marker also ran as an up migration (exit 0), but always write the marker. We use no down section.                                                                            |
| b   | `0001` creates `b1`. `0002` creates `b2`, then runs `SELECT 1/0`.                                                                                | Exit 1 (`division by zero`). `b1` exists and is recorded. `b2` does not exist and `0002` is not recorded: each migration is its own transaction. Without `--no-single-transaction` (the default), both rolled back, nothing recorded, exit 1.                                                                                |
| c   | Two runs started at the same time on a migration containing `pg_sleep(3)` then `CREATE TABLE`.                                                   | Both exit 0 (about 3.8 s in total). The table exists and exactly one row is recorded: the second run waited for the advisory lock, then found nothing to do.                                                                                                                                                                 |
| d   | Files `0010_ten`, `0002_two`, `0001_base` plus `README.md`.                                                                                      | Exit 0. Applied in numeric order `0001`, `0002`, `0010`; the README is ignored and not recorded. With `--check-order`, adding `0005_late` after `0010` has run fails with exit 1 (`Not run migration 0005_late is preceding already run migration 0010_ten`). Never add a migration numbered lower than one already applied. |

Other facts:

- `vantage_migrator` (not a superuser) creates `citext` and `pg_trgm` (both "trusted" extensions) because it owns the database. Both are owned by `vantage_migrator`.
- `node-pg-migrate` has no `status` command, so `status` in the wrapper compares the files with the `pgmigrations` table.
- `VANTAGE_MIGRATIONS_DIR` overrides the folder for experiments and tests only.
