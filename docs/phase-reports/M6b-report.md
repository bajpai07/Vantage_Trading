# M6b report: search, instrument page, order ticket (+ trusted proxy, order preview)

Branch `phase/m6b-trade-ui`. Not pushed.

## 1. Status

**DONE.** T1 to T6 are complete and were verified on a clean clone of the branch: `pnpm verify` exit 0 (910 unit tests, 345 integration tests), a second consecutive `pnpm test:integration` exit 0, `pnpm --filter web build` exit 0, `pnpm --filter web test:e2e` 69 of 69 passed, no leftover `t_*` databases. Caveats: e2e still runs only locally and only in Chromium (not in CI); one contract addition (quote `spread`) and a documented HTTP 200 for not-found instrument pages (section 8).

## 2. Dependency changes

None. No `package.json` or `pnpm-lock.yaml` change (`git diff main --stat -- '*package.json' pnpm-lock.yaml` is empty). Everything uses packages already pinned in M6a (Next 16.4.3, React 19.3.1, zod 4.6.7, Playwright 1.64.1, @axe-core/playwright 4.14.0).

## 3. Task status

| Task                                      | Status | Commit  |
| ----------------------------------------- | ------ | ------- |
| T1 API: trusted proxy (D-69)              | DONE   | b08ac75 |
| T2 API: order preview (D-70)              | DONE   | 2608d54 |
| T3 Web: search and instrument page (D-73) | DONE   | 5947488 |
| T4 Web: order ticket (D-71, D-72)         | DONE   | 080ca94 |
| T5 Tests (unit, M6a state tests, e2e)     | DONE   | 3d279aa |
| T6 Docs, decisions D-69..D-73             | DONE   | 87b12ee |

## 4. Files

Created: `packages/config/src/cidr.ts` and `cidr.test.ts`; `apps/api/src/modules/trading/preview.ts` and `preview.test.ts`; `apps/api/src/modules/orders/orders-preview.int.test.ts`, `orders-preview-fees.int.test.ts`; `apps/api/src/modules/auth/trusted-proxy.int.test.ts`; web `src/lib/{market,backoff,use-quote-poll,ticket,return-to}.ts` with `market.test.ts`, `ticket.test.ts`; `src/components/{search-box,quote-panel,instrument-view,order-ticket}.tsx`, `states.test.tsx`; `src/app/(app)/instruments/[symbol]/page.tsx`, `(app)/not-found.tsx`; `src/instrumentation-client.ts`; `e2e/{proxy-ip,search-instrument,ticket}.spec.ts`; `docs/prompts/M6b_trade_ui.md`; `docs/phase-reports/m6b/*.png` (8 screenshots); this report.

Changed: config (`TRUSTED_PROXY_CIDRS`, `ORDER_PREVIEW_RATE_LIMIT_PER_MINUTE`), API `configure-app.ts`, `common/http.ts`, `tokens.ts`, `orders.module.ts`, `orders.service.ts`, `execute-market-order.ts` (exports `decideForCommand`, used by both the executor and the preview), `quote.service.ts` and `market.int.test.ts` (spread), `testing/e2e-server.ts` (trusted loopback, `/instrument`, `/reconcile`, `/counts` control endpoints), contracts `orders.ts` and `market.ts`, web `config.ts`, `upstream.ts`, `api/[...path]/route.ts`, login page and `auth-forms.tsx` (return-to), `(app)/layout.tsx` (search in header), `search-box.tsx` colour, `playwright.config.ts`, `e2e/helpers.ts`, `eslint.config.mjs` (money guards cover the ticket files), `turbo.json`, both `.env.example` files, `docs/api.md`, `docs/trading.md`, `docs/web.md`, `docs/specs/DECISIONS.md` (5 rows added, 0 deletions). No migration, no old migration edited.

## 5. Commands and exit codes

Clean clone of the branch at `87b12ee` (shared Postgres on 55433; the main working copy's database was stopped first, then restored with `db:reset` and `db:migrate`):

| Command                                        | Exit                                                                       | Result                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`               | 0                                                                          |                                                                                                    |
| `pnpm setup:env --port 55433`, `pnpm db:reset` | 0                                                                          |                                                                                                    |
| `pnpm db:migrate` (twice)                      | 0, 0                                                                       | first applies 0001 to 0023, second "No migrations to run!"                                         |
| `pnpm db:status`                               | 0                                                                          | 0023_equity_snapshots applied                                                                      |
| `pnpm verify`                                  | 0                                                                          | format, lint, typecheck, build, 910 unit tests (35 files), 345 integration tests passed, 3 skipped |
| `pnpm test:integration` (second run)           | 0                                                                          | 345 passed, 3 skipped                                                                              |
| `pnpm --filter web build`                      | 0                                                                          |                                                                                                    |
| `pnpm --filter web test:e2e`                   | 0                                                                          | 69 passed (2.6 min)                                                                                |
| leftover `t_*` databases                       |                                                                            | 0                                                                                                  |
| `node apps/api/dist/main.js --check`           | 0 with a valid `.env`; 2 with an empty environment; 64 for an unknown flag |                                                                                                    |
| `pnpm db:down`                                 | 0                                                                          |                                                                                                    |

The first clone attempt failed only in its setup steps because the main database still held port 55433 (an environment mistake of mine, not a code failure); it was rerun after stopping the main database and is the run reported above. Earlier on the working copy: `pnpm verify` exit 0, full e2e 69 passed, `pnpm lint`, `typecheck` and web `build` clean.

## 6. Acceptance criteria

| #   | Criterion (summary)                                                                                                                                                                                                                         | Result     | Evidence                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Trusted proxy: spoofed `X-Forwarded-For` from an untrusted source is ignored; honoured from a trusted proxy (control); two clients behind the proxy do not share limits; one lockout does not affect the other                              | PASS       | `trusted-proxy.int.test.ts` (8 tests), `cidr.test.ts`, e2e `proxy-ip.spec.ts` (3 tests through the real web proxy)                                                                              |
| 2   | Staging and production must set `TRUSTED_PROXY_CIDRS` explicitly                                                                                                                                                                            | PASS       | config unit tests (startup refuses)                                                                                                                                                             |
| 3   | Preview of the four golden vectors equals the real fill (price, fee, notional)                                                                                                                                                              | PASS       | `orders-preview.int.test.ts`, `orders-preview-fees.int.test.ts`                                                                                                                                 |
| 4   | Every reject code is previewed correctly                                                                                                                                                                                                    | PASS       | all 13 codes compared with real rejects (integration)                                                                                                                                           |
| 5   | Preview writes nothing and takes no locks; no deadlock with concurrent real orders                                                                                                                                                          | PASS       | row counts and ledger unchanged; a held account lock does not block the preview (and does block a real order, as control); 100 previews in parallel with 50 orders, 24 fills, cash 398.08 exact |
| 6   | Preview isolation, auth, CSRF, validation, own rate limit                                                                                                                                                                                   | PASS       | integration tests                                                                                                                                                                               |
| 7   | Search and instrument page: honest freshness, spread as string, status explained, position, recent orders, 404 for unknown                                                                                                                  | PASS       | e2e `search-instrument.spec.ts` (14 tests); HTTP status caveat in section 8                                                                                                                     |
| 8   | Ticket: estimate, review, confirm, fill (vector A: cash 8,099.60, position 10 at 190.04), reconcile clean                                                                                                                                   | PASS       | e2e ticket test 1 with the API's own reconcile                                                                                                                                                  |
| 9   | Sell part then all: realised P&L equals the API string                                                                                                                                                                                      | PASS       | e2e ticket test 2                                                                                                                                                                               |
| 10  | Double click and 50 simultaneous clicks make exactly one order; lost answer then retry reuses the key, one order                                                                                                                            | PASS       | e2e ticket tests 3 and 4 (database counts)                                                                                                                                                      |
| 11  | Edit during review gives a new key, no stale estimate                                                                                                                                                                                       | PASS       | e2e test 5 and reducer unit tests                                                                                                                                                               |
| 12  | STALE, CLOSED, UNAVAILABLE, HALTED, SELL_ONLY disabled with the reason; ACTIVE control enabled; insufficient cash or shares disabled, and forced through the API they are REJECTED with nothing moved; PRICE_MOVED needs a new confirmation | PASS       | e2e tests 6, 7, 8; unit tests over every status, freshness state and all 13 codes                                                                                                               |
| 13  | axe on search, instrument and every ticket step; keyboard-only buy; CSP violation-free, no tokens in storage, no console errors; 375 px                                                                                                     | PASS       | e2e test 10 and 11 (a real violation was found and fixed: see section 8)                                                                                                                        |
| 14  | M6a criterion 10: loading, load-error and error-boundary tests                                                                                                                                                                              | PASS       | `states.test.tsx` (7 tests)                                                                                                                                                                     |
|     | Screenshots                                                                                                                                                                                                                                 | PASS       | `docs/phase-reports/m6b/`: instrument-1280, ticket-estimate-1280, ticket-review-1280, ticket-filled-1280, ticket-retry-1280, ticket-price-moved-1280, ticket-375, ticket-review-375             |
|     | File mode 0600 of env files on Windows                                                                                                                                                                                                      | UNVERIFIED | NTFS has no POSIX modes                                                                                                                                                                         |

## 7. Tests

New unit tests: `cidr.test.ts` (resolver incl. spoofing), `preview.test.ts` (7), `ticket.test.ts` (57: key lifecycle, quantity sanitising, reducer rules, disabled reasons exhaustive over instrument statuses, freshness states and 13 reject codes, return-to whitelist), `market.test.ts` (status views, age text, market line, backoff), `states.test.tsx` (7). Totals: 910 unit tests (web 389).

New integration tests: preview 19 + 2, trusted proxy 8. New e2e: `ticket.spec.ts` 19, `search-instrument.spec.ts` 14, `proxy-ip.spec.ts` 3 (69 e2e in total).

Controls (tests that must fail without the behaviour, or that prove the test can see the failure): a spoofed header from an untrusted source must be ignored while the same header from a trusted proxy is honoured; a real order is blocked by a held lock while the preview is not; a fresh ACTIVE quote enables Review while each blocking state disables it; one click places one order while 50 clicks place one; axe reports a deliberately unlabelled input (M6a control retained); polling continues while visible and stops while hidden.

Not covered by an automated test: the unit test for "no money arithmetic" is the ESLint ban, now applied to `ticket.ts` and `order-ticket.tsx` (lint is part of `pnpm verify`); the 401 mid-order return-to is covered end to end (one e2e test) but only for instrument pages.

## 8. Deviations, findings and spec questions

1. **Quote `spread` added to the contract** (optional, server-computed, ask minus bid): the instrument page must show a spread and the browser may not subtract prices. The M3a market test was updated. Recorded in D-73.
2. **Unknown instrument page answers HTTP 200**, not 404, because the `loading.tsx` state streams before the page decides (documented Next.js behaviour). The not-found content is shown and the page is `noindex`; the e2e test asserts that. If a real 404 status is required, loading states for that route would have to be removed.
3. **`TRUST_FORWARDED_FOR` web setting** (not in the prompt): Next route handlers cannot see the peer address and do not append it to an existing `X-Forwarded-For`, so forwarding the header is an explicit setting (default true in local and test, required in staging and production). Documented in D-69 and `docs/api.md`.
4. **Zod CSP violation found and fixed**: zod 4 probes `new Function()` when schemas are created, which the CSP (no unsafe-eval) reported as a violation in the browser. Fixed with `src/instrumentation-client.ts` (`z.config({ jitless: true })`, must run before the contract schemas exist). Found by the new security e2e test; M6a's tests did not catch it.
5. Two accessibility contrast problems found by axe were fixed (search result exchange label; the "your orders" link inside the retry alert, where the global unlayered `a` colour beat the utility class, so the fix uses an important modifier).
6. Test-only control endpoints `/reconcile` and `/counts` were added to the e2e launcher (never part of the real API).
7. The e2e suite regenerates the M6a screenshots when the whole suite runs; I restored them with git so M6a's artefacts stay as committed.
8. No spec ambiguity required stopping.

## 9. Limitations and what comes next

- E2E is local only and Chromium only; it is not in CI.
- No watchlist screens and no charts (need M3b data); limit and stop orders, fractional shares and streaming are out of scope.
- The idempotency key is memory-only: a reload during an uncertain order loses it (the dialog points the user to Orders to check).
- Estimates are advisory; the real order re-decides on the quote at that moment, so PRICE_MOVED can still occur.
- Tables still scroll sideways on a phone; the terminal layout is not built.
- Staging and production need `TRUSTED_PROXY_CIDRS` (API) and `TRUST_FORWARDED_FOR` (web) set correctly; a wrong value weakens per-IP limits.
- Next: watchlist UI, charts, the real market data provider (M3b), and the M8 hardening checklist (email verification, terms and legal pages, CI including e2e, push to the remote).
