# Web app (M6a): foundation, auth and the portfolio screens

`apps/web` is a Next.js (App Router) app: register, sign in, sign out, and read-only screens for the portfolio, orders, fills and account activity. **No trade ticket, instrument search or price charts yet (M6b).** Decisions D-64 to D-68 are in specs/DECISIONS.md; the API it uses is in [api.md](api.md); the definitions behind the numbers are in [portfolio.md](portfolio.md).

## Structure

```
apps/web/
  next.config.ts            validates the config at startup; static security headers
  postcss.config.mjs        Tailwind v4 (PostCSS plugin)
  playwright.config.ts      e2e configuration (ports, poll interval, web server)
  e2e/                      Playwright specs and helpers
  src/
    proxy.ts                per-request CSP nonce + route protection (Next 16 "proxy", Node runtime)
    app/
      layout.tsx            fonts, the market data banner, the footer
      api/[...path]/route.ts  the same-origin proxy to the API (D-65)
      (auth)/login, register  forms (client components)
      (app)/layout.tsx      private layout: checks the session on the server, header, nav, sign out
      (app)/portfolio, orders, activity   server-rendered first paint, loading.tsx, error.tsx
    components/             FreshnessBadge, Money, PnlCell, EquityLine, PortfolioView, OrdersList, ...
    lib/
      config.ts             validated configuration (API_BASE_URL, PORTFOLIO_POLL_MS, APP_ENV)
      api-core.ts           interprets every API response: validated against @vantage/contracts or a safe failure
      server-api.ts, client-api.ts  server and browser access (the browser only ever calls /api/*)
      money.ts, format.ts   string-only display helpers (no number conversion)
      freshness.ts, reject-copy.ts  freshness labels and the plain sentence for every reject code
      csp.ts, upstream.ts   CSP builder; proxy path allowlist and header filtering
    styles/tokens.css       the design tokens (the only place raw colours live)
```

## Running

Prerequisites: the repo quickstart (`pnpm install`, `pnpm setup:env`, `pnpm db:up`, `pnpm db:migrate`, `pnpm build`).

```powershell
# terminal 1: the API on port 4000 (PORT=4000 and WEB_ORIGIN=http://localhost:3000 are the .env.example defaults)
node --env-file=.env apps/api/dist/main.js

# terminal 2: the web app on http://localhost:3000
copy apps\web\.env.example apps\web\.env.local      # API_BASE_URL=http://127.0.0.1:4000
pnpm --filter web dev
```

`pnpm --filter web build` and `pnpm --filter web start` serve the production build. Configuration (names, never values, are reported when it is wrong):

| Variable            | Meaning                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `API_BASE_URL`      | Origin of the API (no path, no trailing slash). Default `http://127.0.0.1:4000` in local and test; **required** when `APP_ENV` is staging or production. Read at request time. |
| `APP_ENV`           | `local` (default), `test`, `staging`, `production`.                                                                                                                            |
| `PORTFOLIO_POLL_MS` | Portfolio refresh interval while the tab is visible, 1000 to 300000 (default 15000).                                                                                           |

`pnpm verify` now includes the web app: format check, ESLint, `tsc` (via `next typegen`), `next build`, and the unit tests (`apps/web/**/*.test.{ts,tsx}`, rendered on the server with `react-dom/server`, no browser).

## End-to-end tests (Playwright) on Windows

The e2e suite is **not part of `pnpm verify` and not in CI yet**. It drives a real Chromium against the real production build of the web app, the real API (Nest, as `vantage_app`) and a real throwaway Postgres database, with FIXTURE quotes and the API's injected clock (Tuesday 2026-11-10 10:00 New York, market open, so quote times are deterministic). A small test-only control server (`apps/api/src/testing/e2e-server.ts`) lets a test set quotes and the clock; nothing like it exists in the real API.

```powershell
pnpm install --frozen-lockfile
pnpm db:up ; pnpm db:migrate
pnpm --filter web exec playwright install chromium      # once: downloads the browser (about 120 MB)
pnpm --filter web build                                  # the e2e server runs the production build
pnpm --filter web test:e2e                               # 33 tests, about 1.5 minutes
```

Ports used (so a running dev server is not disturbed): web 3100, API 4100, control 4101. The run creates one `t_*` database and drops it at the end (`pnpm test:cleanup` removes strays after a crash). Failure traces and screenshots go to `apps/web/test-results/` (git-ignored); the screenshots in `docs/phase-reports/m6a/` are written by the specs.

## Honesty rules (and where each is enforced)

- **Money is displayed exactly as the API sent it.** Every amount, price and quantity is a string; `money.ts` and `format.ts` use string operations only (thousands separators, a real minus sign U+2212, an explicit `+` for gains). ESLint bans `Number()`, `parseInt`, `parseFloat`, `Math.*`, unary `+` and decimal literals in those files; a property test proves that the digits that go in are the digits that come out (negative, zero, huge, 8 dp, beyond float range). The browser never adds up money: totals come from the API. The equity line is drawn from exact BigInt values (only pixel positions are numbers); its labels are the original strings.
- **Rounded and exact.** The API sends 2 dp amounts and an `exact` companion; the screen shows the 2 dp value and the exact value on hover and in the "Exact amounts" detail.
- **Every valuation shows its freshness badge** (`REAL-TIME`, `DELAYED`, `STALE`, `CLOSED`, `UNAVAILABLE`: a dot and a word, never colour alone) and the quote time in UTC. A test proves the mapping is exhaustive against the contract.
- **No usable price is never a number.** An `UNAVAILABLE` position is flagged ("No price: excluded from totals"), its value cells show a dash, the "Incomplete valuation" notice appears, equity says it excludes it, and **total return `null` shows a dash, never 0**.
- **The FIXTURE banner comes from the API** (`GET /v1/market/feed`), is non-dismissible, and is on every page including login. If the API cannot be asked, the banner says the status is unavailable instead of assuming real data.
- **"Virtual money — not real trading"** is in the footer of every page.
- **P&L is never colour alone:** a sign, a ▲ or ▼ glyph and a screen-reader word ("gain", "loss") accompany the colour.
- **Responses are validated:** a success body that does not match its `@vantage/contracts` schema becomes a safe error ("We received an unexpected answer from the server, so nothing was shown"), never rendered.
- **Errors are friendly:** the API's message is never shown; each failure kind has its own sentence, and the request id appears only as a "Support code" line.

## Copy for every reject code

Shown on the Orders screen (`src/lib/reject-copy.ts`; a unit test checks that this list equals the contract's 13 codes). An unknown code gets the generic sentence.

| Code                        | Sentence                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `TRADING_PAUSED`            | Trading is paused right now, so the order was not placed.                                    |
| `ACCOUNT_NOT_ACTIVE`        | Your account is not active, so orders cannot be placed.                                      |
| `INSTRUMENT_NOT_TRADABLE`   | This instrument cannot be traded at the moment.                                              |
| `INSTRUMENT_HALTED`         | Trading in this instrument is halted.                                                        |
| `QTY_BELOW_MIN`             | The quantity is below the minimum allowed for this instrument.                               |
| `QTY_STEP_VIOLATION`        | The quantity is not a multiple of the size this instrument trades in.                        |
| `NO_ELIGIBLE_QUOTE`         | There was no usable price for this instrument, so the order was not filled.                  |
| `MARKET_CLOSED`             | The market was closed, so the order was not filled.                                          |
| `STALE_QUOTE`               | The latest price was too old to trade against, so the order was not filled.                  |
| `PRICE_MOVED`               | The price moved more than 1% against you since you last saw it, so the order was not filled. |
| `INSUFFICIENT_BUYING_POWER` | You did not have enough cash to cover this purchase, including fees.                         |
| `INSUFFICIENT_POSITION`     | You do not own enough shares to sell that quantity.                                          |
| `FEE_EXCEEDS_PROCEEDS`      | The fee would have been larger than the sale proceeds, so the sale was not made.             |
| (anything else)             | The order was rejected. If this keeps happening, contact support.                            |

## Security

- **Cookie:** `vantage_session` is set by the API, httpOnly and SameSite=Lax, and only ever travels through the same-origin proxy; script cannot read it, and nothing is stored in localStorage, sessionStorage, IndexedDB or readable cookies (tested).
- **CSP** (set per request in `src/proxy.ts`): `script-src 'self' 'nonce-…' 'strict-dynamic'` (a fresh nonce each request, no `unsafe-inline`, no `unsafe-eval` in production), `style-src 'self' 'nonce-…'`, `default-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`; `upgrade-insecure-requests` in staging and production. Also `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a restrictive `Permissions-Policy`, and HSTS in staging and production. The e2e suite fails on any console error, which includes CSP violations.
- **Proxy:** only `/v1/*` and `/health` reach the API; `..`, encoded slashes and other prefixes are refused; hop-by-hop headers are dropped; every `Set-Cookie` is passed through as its own header; nothing is cached or logged.
- **Passwords** are sent as a JSON body (the forms use `method="post"`), never in a URL, and nothing logs them.

## Accessibility and responsiveness

Labelled fields with inline errors tied by `aria-invalid` and `aria-describedby`, a skip link, visible 2 px focus rings, tables with captions and header cells, a focusable scroll region for wide tables, `prefers-reduced-motion` respected, links in text underlined. Below 768 px the navigation is a bottom tab bar with 44 px targets; at 375 px there is no horizontal page scroll (wide tables scroll inside their own region). axe-core reports no serious or critical violation on any page in the e2e run (WCAG 2.2 AA tags).

## Known limits

- Tables scroll sideways on a phone instead of turning into two-line cards (DESIGN_SYSTEM section 5); cards come with the terminal layout in M6b.
- The API sees every web user as the proxy's address, so its per-IP login and registration limits are shared by all web users until a trusted-proxy setting exists (api.md, rate limits).
- No Storybook, visual regression or Lighthouse budget yet (DESIGN_SYSTEM section 10); the e2e suite is not in CI.
