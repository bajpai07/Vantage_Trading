# VANTAGE · Claude Code Prompt · M1 — LEDGER CORE

Environment: native Windows, PowerShell, Docker Desktop, repo at `C:\dev\vantage` (not in OneDrive), Node 22.19.0 pinned. The Postgres host port comes from `POSTGRES_HOST_PORT` in `.env.infra` (never hard-code a port). Carry over every M0 rule (exact versions, no secrets in git or on command lines, LF endings, stop-and-report on ambiguity, never mark anything passed unless you ran it, no push).

## 1. Goal

Build the financial heart of VANTAGE: an **exact-decimal money type**, a **double-entry append-only ledger enforced by the database**, **pure posting recipes**, and a small **ledger repository**. Nothing else. No users table, auth, orders, quotes, lots, positions, API routes or UI.

At the end, these must be provably true: money never touches a JS float; every transaction balances per currency; ledger rows can never be changed or deleted (by the app, and even by the table owner through triggers); cash can never go negative, even under concurrency; a repeated idempotency key never posts twice; fees are recorded separately (zero fee allowed).

Specs (read in full first): DATABASE §1, §2, §5 (`fx_rates` only), §6, §11, §13; TRADING_ENGINE §1, §5, §9, §11 (I1–I3, I10). If a spec is ambiguous or contradicts this prompt, stop and report. Do not invent.

## 2. Step 0: M0 check (before any M1 change)

1. Make sure `main` contains M0. If not: `git checkout main`, `git merge --no-ff phase/m0-foundation` (local only). Then create branch `phase/m1-ledger`.
2. Run `pnpm install --frozen-lockfile`, `pnpm db:up`, `pnpm db:migrate`, `pnpm verify`. All must pass. If anything fails, stop and report; do not start M1.
3. Print to chat, verbatim, these parts of `docs/phase-reports/M0-report.md`: the migration experiment results (a)–(d); the "Windows notes" section; the 12-item acceptance table; and the list of the 11 integration tests with their names. Do not edit the M0 report.
4. Add one short note to DATABASE §12 and D-15 in `docs/specs`: "superseded by D-35 (plain SQL migrations via node-pg-migrate; Prisma is a client for non-ledger tables only, schema by introspection, no `prisma migrate`)". Append only; delete nothing.

## 3. Layout additions

```
packages/money/src/          # implemented now
packages/engine/             # NEW, pure and deterministic: posting recipes only
apps/api/src/modules/ledger/ # repository + errors + reconcile (uses pg)
db/migrations/0002..000N_*.sql
docs/ledger.md
```
`packages/engine` and `packages/money` are covered by the existing ESLint money/determinism guards. `apps/api` may import `pg`; `packages/*` may not. Pin exact versions of any new dependency (`decimal.js`, `fast-check`, `pg`, `@types/pg`).

## 4. Tasks (in order; verify each; commit after each)

**T1 · `@vantage/money`.**
- Built on `decimal.js` with a fixed configuration (precision at least 40 significant digits, no exponent notation in output). Public API takes and returns **strings or the Decimal wrapper, never JS numbers**.
- `parse(s)`: accepts only `^-?\d+(\.\d+)?$` (no exponent, spaces, `NaN`, `Infinity`, or empty string); anything else throws a typed error.
- Operations: add, sub, mul, div (explicit rounding required), compare, min/max, negate, isZero, sign.
- Rounding: `round8(x)` = 8 dp HALF_EVEN (TRADING_ENGINE §9); `roundToTickUp(price, tick)` and `roundToTickDown(price, tick)` for later use. `toDbString(x)` returns a plain fixed-point string for Postgres `numeric`.
- Tests: `0.1 + 0.2` equals `0.3` exactly; 18-digit integers and 10-decimal fractions round-trip; the parse rejects every bad input above; HALF_EVEN at the tie points (`0.000000005` → `0.00000000`, `0.000000015` → `0.00000002`); fast-check properties: `(a + b) − b = a`, `a + b = b + a`, `round8` idempotent, tick rounding never moves a price the wrong way.
- Done when: `pnpm lint` still proves no float usage in this package, and the tests pass.

**T2 · Ledger schema (plain SQL migrations, forward-only, per-migration transaction).**
Create the objects from DATABASE §2, §5 and §6 exactly as specified, in this scope only: needed enums and the `currencies` table (with USD and INR rows); `fx_rates`; `accounts`; `ledger_accounts`; `ledger_transactions`; `ledger_entries` with their indexes and CHECKs.
- **Deviation to record (D-38):** `accounts.user_id` is `uuid NOT NULL` **without** the foreign key to `users`; the M2 migration that creates `users` adds the constraint. Keep the unique partial index `accounts_one_main`.
- `ledger_accounts.balance` CHECK: `CASH`, `RESERVED`, `POSITION_COST` ≥ 0. Add a BEFORE INSERT guard so a new ledger account always starts at balance 0.
- Done when: `db:migrate` applies cleanly twice (second run no-op) and `db:status` lists all migrations.

**T3 · Ledger triggers and privileges.**
1. `forbid_mutation()` as BEFORE UPDATE OR DELETE **row** triggers on `ledger_transactions`, `ledger_entries`, `fx_rates`, **and** BEFORE TRUNCATE **statement** triggers on the same tables (TRUNCATE skips row triggers, so it needs its own).
2. `apply_entry()` AFTER INSERT on `ledger_entries` updates the balance. Make it `SECURITY DEFINER`, owned by the migrator, with `SET search_path = public, pg_temp`, and `REVOKE ALL ON FUNCTION … FROM PUBLIC`. Reason: `vantage_app` must update balances only through entries, so it gets **no UPDATE privilege** on `ledger_accounts`.
3. `assert_tx_balanced()` as the DEFERRABLE INITIALLY DEFERRED constraint trigger from DATABASE §6 (per-currency sum must be zero at commit).
4. Grants to `vantage_app` (explicit, minimal): `SELECT` on `accounts`, `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `fx_rates`, `currencies`; `INSERT` on `accounts`, `ledger_accounts`, `ledger_transactions`, `ledger_entries`; `USAGE` on the `ledger_entries` id sequence. **No UPDATE, DELETE or TRUNCATE on anything.** Check that PG lets the app insert entries and still update balances through the SECURITY DEFINER trigger (this is a claim: prove it by a test). Any new function must have `EXECUTE` revoked from PUBLIC.
- Done when: the integration tests in T6 pass.

**T4 · `@vantage/engine` (pure recipes; no IO, no time, no randomness).**
A leg is `{ ledgerAccountType, currency, amount: string }` (signed, as in TRADING_ENGINE §5). Functions return the legs of one ledger transaction and **assert in code that each currency sums to exactly zero** before returning. Zero-amount legs are omitted (the DB forbids zero entries). USD only in M1; any other currency input throws.
- `grantLegs({ amount })`: `CASH +A`, `CAPITAL −A`.
- `buyFillLegs({ qty, price, fee })` (synchronous execution, approved D-30, so **no RESERVED movement**): `C = round8(qty × price)`, `f = round8(fee)`; `CASH −(C + f)`, `POSITION_COST +C`, `FEES +f`.
- `sellFillLegs({ qty, price, fee, basis })`: `P = round8(qty × price)`, `f = round8(fee)`, `B = round8(basis)`; `CASH +(P − f)`, `FEES +f`, `POSITION_COST −B`, `REALIZED_PNL −(P − B)`.
- Every leg is computed once and the cash leg derived by addition/subtraction of already-rounded values (TRADING_ENGINE §9).
- **Golden vectors, hard-coded as strings in the tests (never computed by the code under test):**
  - Grant 10,000: `CASH +10000.00000000`, `CAPITAL −10000.00000000`.
  - **A** (buy 10 at 190.04, fee 0): `CASH −1900.40`, `POSITION_COST +1900.40`; cash after grant = 8,099.60.
  - **B** (buy 0.05 at 60,030.00, fee 3.0015): `CASH −3004.5015`, `POSITION_COST +3001.50`, `FEES +3.0015`.
  - **Sell, no fee** (10 at 195.00, basis 1,900.40): `CASH +1950.00`, `POSITION_COST −1900.40`, `REALIZED_PNL −49.60`.
  - **Sell with fee** (same, fee 1.95): `CASH +1948.05`, `FEES +1.95`, `POSITION_COST −1900.40`, `REALIZED_PNL −49.60`.
  - Verify each vector sums to zero by hand in the test comments.
- Property test: random valid inputs (decimal strings with up to 8 dp) always produce legs that sum to exactly zero per currency.
- Done when: unit tests pass and `pnpm lint` proves the engine has no floats, no `Date`/`Math.random`, no IO imports.

**T5 · Ledger repository** (`apps/api/src/modules/ledger`, uses `pg`; takes a `pg` client that **already has an open transaction**, so M4 can put order and ledger work in one transaction).
- `createAccount(client, { accountId, userId, kind, initialCapital })`: inserts the account and the standard USD ledger accounts (`CASH`, `RESERVED`, `POSITION_COST`, `FEES`, `REALIZED_PNL`, `CAPITAL`).
- `postTransaction(client, { accountId, kind, idempotencyKey, description, legs })`:
  1. insert the transaction row with `ON CONFLICT (account_id, idempotency_key) DO NOTHING`;
  2. if it already existed, **compare the stored entries with the new legs**: identical → return the existing transaction (`created: false`); different → throw `IdempotencyConflictError` and post nothing;
  3. otherwise insert entries **sorted by `ledger_account_id`** (one consistent lock order, so concurrent multi-leg transactions cannot deadlock);
  4. run `SET CONSTRAINTS ledger_tx_balanced IMMEDIATE` so an unbalanced transaction fails at once (then set it back to `DEFERRED`);
  5. map database errors to typed errors: balance CHECK → `InsufficientFundsError`; unbalanced → `LedgerUnbalancedError`; other errors pass through.
- `grantInitialCapital(client, accountId)` using key `grant:<accountId>` and the engine's `grantLegs`.
- `reconcileAccount(client, accountId)`: read-only; runs DATABASE §13 queries and checks I1, I2, I3 and I10 (per-currency conservation, and `CAPITAL` balance = −grants), returns a list of violations (empty = clean).
- Parameters are always strings with `$n::numeric`. Do **not** register any `pg` type parser that turns `numeric` into a JS number; a test proves a read returns a string (for example `0.1000000000`).
- Done when: the T6 tests pass.

**T6 · Tests (real Postgres through the M0 `createTestDatabase()` helper; each "must fail" has a "control succeeds" partner).**
1. **Grant:** one grant gives `CASH = 10000`, `CAPITAL = −10000`, and `reconcileAccount` is clean.
2. **Golden vectors A and B and both sells** posted through the repository: exact entry rows and final balances match the hard-coded expectations.
3. **Immutability:** as `vantage_app`, `UPDATE`/`DELETE`/`TRUNCATE` on `ledger_entries`, `ledger_transactions` and `fx_rates` all fail (permission denied); as the migrator, the same statements fail with the append-only exception (triggers, including TRUNCATE). Control: `INSERT` works for the app.
4. **Balance protection:** a hand-built unbalanced transaction fails; a hand-built balanced **multi-currency** transaction (USD legs sum to zero, INR legs sum to zero) succeeds, which proves the per-currency rule and the multi-currency foundation. A transaction that nets to zero overall but not per currency fails.
5. **No direct balance edits:** as `vantage_app`, `UPDATE ledger_accounts SET balance = …` fails, while inserting an entry still updates the balance (SECURITY DEFINER proof). A zero amount entry is rejected.
6. **No overdraft:** a buy larger than cash fails with `InsufficientFundsError`, nothing is posted, and the balance is unchanged.
7. **Concurrency:** with cash 10,000 and 50 parallel buys of 400 each, exactly 25 succeed, the rest fail with `InsufficientFundsError`, final cash is exactly 0, no deadlocks, and `reconcileAccount` is clean. With 100 parallel posts of the same idempotency key, exactly one transaction exists and all calls return that same transaction id. A repeated key with **different** legs throws `IdempotencyConflictError`.
8. **Property test on Postgres** (fast-check, about 30 runs of up to 15 operations): random buys and sells (the test chooses basis up to the current `POSITION_COST`), with `reconcileAccount` clean after every step and `REALIZED_PNL` equal to −Σ(P − B).
9. **Numeric fidelity:** values with 10 decimals and 18-digit integers round-trip through Postgres unchanged.
- Done when: `pnpm verify` is green, and `pnpm test:integration` passes **twice in a row** with no leftover `t_*` databases.

**T7 · Docs and decisions.**
- `docs/ledger.md` (short): sign convention, the recipes with the golden vectors, how a new posting type is added (engine recipe, then repository, then tests), and the rule "app role has no UPDATE/DELETE/TRUNCATE; balances change only through entries".
- Append rows to the `docs/specs/DECISIONS.md` table without editing existing lines (before `## Open assumptions`), each marked `APPROVED by founder (M1)`: **D-38** `accounts.user_id` foreign key added in M2; **D-39** MVP recipes post fills directly (no RESERVED movement) because execution is synchronous; the `RESERVED` type stays in the schema for later; **D-40** ledger layering: pure recipes in `packages/engine`, SQL in `apps/api` ledger module, `apply_entry` is SECURITY DEFINER, the app role has no UPDATE/DELETE/TRUNCATE. Verify `git diff --numstat docs/specs/DECISIONS.md` shows no deletions.

## 5. Out of scope (do not build)
`users`, auth, sessions; orders, executions, lots, positions; quotes or market data; INR/FX recipes and reservation logic; account events/outbox; snapshots; NestJS, Prisma, Next.js, Redis; API routes; UI; any migration beyond T2/T3; any grant beyond T3.

## 6. Common mistakes
Floats anywhere (including in tests that feed money values); setting a `pg` numeric parser; granting UPDATE on `ledger_accounts` "for convenience"; forgetting the TRUNCATE trigger; inserting entries in random order (deadlocks); relying on the deferred trigger alone for error messages; expected values in tests computed by the code under test; "must fail" tests with no control; editing old migrations (always add a new file); editing existing spec lines.

## 7. Verification (run on a clean clone of the branch)
```powershell
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate ; pnpm db:migrate ; pnpm db:status
pnpm verify
pnpm test:integration          # second consecutive run
pnpm db:down
```

## 8. Acceptance criteria (run each; PASS / FAIL / UNVERIFIED)
1. Step 0 evidence printed; M0 baseline green.
2. `money`: parse rejects every bad input; HALF_EVEN tie tests pass; properties pass; lint proves no float use.
3. Engine golden vectors (grant, A, B, two sells) match exactly and sum to zero per currency; engine is lint-clean for determinism.
4. Migrations apply forward-only; second run is a no-op.
5. App role cannot UPDATE/DELETE/TRUNCATE any ledger table; the migrator is stopped by triggers (including TRUNCATE).
6. Unbalanced and per-currency-unbalanced transactions are rejected; a balanced multi-currency transaction succeeds.
7. `vantage_app` cannot edit `ledger_accounts.balance`, but entries still update it.
8. Overdraft fails with a typed error and no partial post.
9. 50-way concurrent buys: exactly 25 succeed, cash 0, no deadlock; 100 same-key posts: exactly 1 transaction; differing legs under the same key throw.
10. Postgres property test passes with a clean reconcile after every step.
11. Numeric round-trip (10 dp, 18 digits) is exact; no float parser registered.
12. `pnpm verify` green and integration green twice in a row; no leftover test databases.
13. `docs/ledger.md` exists; D-38, D-39, D-40 appended with zero deletions; the DATABASE §12/D-15 supersede note added.

## 9. Final report (`docs/phase-reports/M1-report.md`, also printed)
1. Status: READY / READY WITH CAVEATS / NOT READY for M2 (≤ 5 lines).
2. Step 0 evidence (the four M0 items) and your assessment of M0.
3. New dependency versions and how verified.
4. Task status T1–T7.
5. Files created / modified.
6. Commands run with exit codes and durations; failing output verbatim.
7. Acceptance table (13 items) with evidence.
8. The test list, each "must fail" with its control.
9. Deviations, surprises, spec questions (stop-and-report format).
10. Known limitations. M2 readiness: the `users` table and the `accounts.user_id` foreign key are the first M2 migration.

Do not start M2. Stop after the report.
