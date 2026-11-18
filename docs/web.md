# Web app (M6a, M6b): foundation, portfolio screens, search, instrument page and order ticket

`apps/web` is a Next.js (App Router) app: register, sign in, sign out, and read-only screens for the portfolio, orders, fills and account activity. From M6b it also has header search, the instrument page and a market-order ticket. **No watchlist screens and no price charts yet.** Decisions D-64 to D-68 (M6a) and D-69 to D-73 (M6b) are in specs/DECISIONS.md; the API it uses is in [api.md](api.md); the definitions behind the numbers are in [portfolio.md](portfolio.md).

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
      (app)/instruments/[symbol]   instrument page (M6b); not-found.tsx for unknown symbols
    instrumentation-client.ts   runs first in the browser: turns off zod's `new Function` probe (the CSP has no unsafe-eval)
    components/             FreshnessBadge, Money, PnlCell, EquityLine, PortfolioView, OrdersList, SearchBox,
                            QuotePanel, InstrumentView, OrderTicket, ...
    lib/
      config.ts             validated configuration (API_BASE_URL, PORTFOLIO_POLL_MS, APP_ENV)
      api-core.ts           interprets every API response: validated against @vantage/contracts or a safe failure
      server-api.ts, client-api.ts  server and browser access (the browser only ever calls /api/*)
      money.ts, format.ts   string-only display helpers (no number conversion)
      freshness.ts, reject-copy.ts  freshness labels and the plain sentence for every reject code
      market.ts             instrument status views (what each status blocks), "x s ago", market line
      use-quote-poll.ts, backoff.ts  quote polling (D-73)
      ticket.ts             the order ticket as a pure state machine + disabled reasons (D-72)
      return-to.ts          safe "come back after sign in" paths
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

| Variable              | Meaning                                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_BASE_URL`        | Origin of the API (no path, no trailing slash). Default `http://127.0.0.1:4000` in local and test; **required** when `APP_ENV` is staging or production. Read at request time.                                                                |
| `APP_ENV`             | `local` (default), `test`, `staging`, `production`.                                                                                                                                                                                           |
| `PORTFOLIO_POLL_MS`   | Portfolio refresh interval while the tab is visible, 1000 to 300000 (default 15000).                                                                                                                                                          |
| `QUOTE_POLL_MS`       | Instrument quote refresh interval while the tab is visible, 1000 to 60000 (default 5000). D-73.                                                                                                                                               |
| `TRUST_FORWARDED_FOR` | Whether the proxy route forwards the browser's `X-Forwarded-For` to the API (default true in local and test; **required** in staging and production). Set it to true only when this app sits behind a proxy that overwrites the header. D-69. |

`pnpm verify` now includes the web app: format check, ESLint, `tsc` (via `next typegen`), `next build`, and the unit tests (`apps/web/**/*.test.{ts,tsx}`, rendered on the server with `react-dom/server`, no browser).

## End-to-end tests (Playwright) on Windows

The e2e suite is **not part of `pnpm verify` and not in CI yet**. It drives a real Chromium against the real production build of the web app, the real API (Nest, as `vantage_app`) and a real throwaway Postgres database, with the simulated (SIM) feed in demo mode (stocks and crypto) and the API's injected clock (Tuesday 2026-11-10 10:00 New York, market open, so quote times are deterministic). A small test-only control server (`apps/api/src/testing/e2e-server.ts`) lets a test set quotes and the clock; nothing like it exists in the real API.

```powershell
pnpm install --frozen-lockfile
pnpm db:up ; pnpm db:migrate
pnpm --filter web exec playwright install chromium      # once: downloads the browser (about 120 MB)
pnpm --filter web build                                  # the e2e server runs the production build
pnpm --filter web test:e2e                               # runs both profiles: 80 tests, about 3.5 minutes
```

Ports used (so a running dev server is not disturbed): web 3100, API 4100, control 4101. `test:e2e` runs two profiles one after the other (`e2e/run-all.mjs`): the default NYSE session, and `E2E_PROFILE=always-open` (`SIM_SESSION=ALWAYS_OPEN`, ports 3200, 4200, 4201, only `always-open.spec.ts`: the "Simulated 24/7 session" banner and a stock traded at a weekend instant; its NYSE control is in `sim-feed.spec.ts`). `pnpm --filter web test:e2e:default` runs only the default profile. The run creates one `t_*` database and drops it at the end (`pnpm test:cleanup` removes strays after a crash). Failure traces and screenshots go to `apps/web/test-results/` (git-ignored); the screenshots in `docs/phase-reports/m6a/` and `m6b/` are written by the specs. The test API also has two test-only control endpoints, `POST /reconcile` (the API's own zero-tolerance reconciliation) and `POST /counts` (orders and executions of a user), used to prove "exactly one order" and clean books.

## Search, instrument page and order ticket (M6b)

**Search** (header, every private page): type to search `/v1/instruments/search` (250 ms debounce, newest answer wins); `/` focuses the box, Up/Down/Enter choose, Escape closes then clears. Each result shows symbol, name, exchange, type and a badge when the instrument is not ACTIVE. "No results" is a normal answer worded as one; a failed search says so and offers "Try again".

**Instrument page** (`/instruments/AAPL`): name, symbol, exchange, status (HALTED, SELL_ONLY and DELISTED are explained in a sentence), the quote panel (bid, ask, last and the server-computed spread as strings, freshness badge, source, as-of in UTC and "x s ago", the exchange's open/closed line from `/v1/market/status`), your position in this symbol, your recent orders in it, and the ticket. An unknown or malformed symbol shows the not-found page (the HTTP status stays 200 because the loading state streams first; the page is marked `noindex`). The quote refreshes itself (D-73).

**Order ticket** (market orders, whole shares only):

1. Choose Buy or Sell and type a quantity. The field takes digits only (letters, signs, decimals and exponents never get in; a paste that is not only digits is refused) and at most the contract maximum.
2. After 300 ms the ticket asks `POST /v1/orders/preview` and shows the estimate: estimated price, cost or value, fee, estimated proceeds (sell) and cash after, labelled "Estimate — final price is decided when the order executes." The estimate is the server's; the browser adds nothing up.
3. **Review** opens a modal dialog: side, quantity, estimated price, cost, fee, cash after, the quote's time and source. Confirm reads "Buy 10 AAPL" or "Sell 4 AAPL". The estimate is frozen while you review.
4. **Confirm** sends `POST /v1/orders`. A fill shows price, quantity, value, fee and cash now (from `/v1/account`) and a link to Orders; the position and recent orders on the page update without a reload. A reject shows the plain sentence for its code and says nothing was changed. `PRICE_MOVED` also shows the current price and offers "Review again": nothing is resubmitted automatically (D-71).

**A disabled button always says why**, in this order: request in flight; the instrument cannot be traded yet (crypto before M8: "This instrument is not tradable yet: its prices are shown, but trading it arrives in a later update.", no estimate is requested); instrument status (HALTED blocks both sides, SELL_ONLY blocks buying, DELISTED both); quote UNAVAILABLE, CLOSED or STALE; no bid or ask; a failed price refresh; no quantity; quantity above the maximum; selling with no position; the estimate still calculating or failed; and finally the reject sentence of whatever the preview says would happen (not enough cash, not enough shares, trading paused, and so on).

### Idempotency key lifecycle (D-72)

| Event                                               | Key                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Review opened                                       | a new key (`crypto.randomUUID()`), kept in memory only                                                                                           |
| Network error, timeout, 5xx, 429, unreadable answer | **kept**: "Retry safely" resends with the same key; the dialog says the order may or may not have been placed and links to Orders                |
| Fill, reject, or a 4xx answer                       | discarded                                                                                                                                        |
| Edit side or quantity, or cancel the review         | discarded (the review closes and the estimate is dropped)                                                                                        |
| Second click while a request is in flight           | nothing happens (a synchronous guard, not only a disabled button)                                                                                |
| 401                                                 | the user is sent to sign in and returned to the same instrument page (only a short list of our own paths is ever accepted as the return address) |

The state machine is `lib/ticket.ts` (pure, unit-tested); `components/order-ticket.tsx` only renders it.

### Keyboard, focus and motion

Everything works with the keyboard: `/` to search, Enter to review and to confirm. The dialogs are native `<dialog>` elements opened with `showModal()`: focus moves to the dialog heading, Tab stays inside, Escape closes, and results are announced (`aria-live`). Buttons are 44 px high on a phone. Pulses respect `prefers-reduced-motion`.

## Day change (M7b, D-82)

The quote panel has a **Change** card and each search result a compact percentage. Both are the API's strings (`change`, `changePct`, `changeBasis`); `lib/change.ts` only assembles text with string operations (ESLint bans number conversion and arithmetic there and in `change-cell.tsx`): "+3,364.25 (+4.67%)", "−3.61 (−1.89%)" (a real minus sign), "0.00 (0.00%)". Sign, a ▲ or ▼ glyph and a screen-reader word accompany the colour (never colour alone); zero has no arrow. The basis is shown as a label and a tooltip: **"vs previous close"** (stocks on the real calendar) or **"24h"** (crypto and the simulated 24/7 session). No prior data renders "—" with "no prior close yet", never 0. Search results ask `/v1/quotes` once per search for the visible symbols; if that fails the percentage is simply left out.

## Honesty rules (and where each is enforced)

- **Money is displayed exactly as the API sent it.** Every amount, price and quantity is a string; `money.ts` and `format.ts` use string operations only (thousands separators, a real minus sign U+2212, an explicit `+` for gains). ESLint bans `Number()`, `parseInt`, `parseFloat`, `Math.*`, unary `+` and decimal literals in those files; a property test proves that the digits that go in are the digits that come out (negative, zero, huge, 8 dp, beyond float range). The browser never adds up money: totals come from the API. The equity line is drawn from exact BigInt values (only pixel positions are numbers); its labels are the original strings.
- **Rounded and exact.** The API sends 2 dp amounts and an `exact` companion; the screen shows the 2 dp value and the exact value on hover and in the "Exact amounts" detail.
- **Every valuation shows its freshness badge** (`REAL-TIME`, `DELAYED`, `STALE`, `CLOSED`, `UNAVAILABLE`: a dot and a word, never colour alone) and the quote time in UTC. A test proves the mapping is exhaustive against the contract.
- **No usable price is never a number.** An `UNAVAILABLE` position is flagged ("No price: excluded from totals"), its value cells show a dash, the "Incomplete valuation" notice appears, equity says it excludes it, and **total return `null` shows a dash, never 0**.
- **The market data banner comes from the API** (`GET /v1/market/feed`), is non-dismissible, and is on every page including login. It is built from the per-class `sources` (M7a, D-75): simulated stocks and crypto say "Simulated market data — not real prices"; a live class (a future adapter) says "live public exchange data — demo" with its source name; a mix says each class's own truth; the simulated 24/7 stock session adds "Simulated 24/7 session"; and demo mode (`DEMO_MODE=true`, D-77) adds "Demo mode — virtual money, no real trading". The footer also says "This is a demo" in demo mode. A feed that should be publishing but is not gets its own notice ("The stock price feed is not publishing right now") in a separate element, so the banner text itself stays about what the data is. If the API cannot be asked, the banner says the status is unavailable instead of assuming real data.
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

- Tables scroll sideways on a phone instead of turning into two-line cards (DESIGN_SYSTEM section 5); the terminal layout is not built.
- Shared per-IP limits are fixed by the trusted-proxy setting (D-69, api.md): set `TRUSTED_PROXY_CIDRS` on the API and `TRUST_FORWARDED_FOR` on the web app in staging and production.
- No watchlist screens and no charts (they need M3b data). Limit and stop orders, fractional shares and streaming prices are out of scope.
- The idempotency key is memory-only: reloading the page during an uncertain order loses it, and the dialog points the user to the Orders page to check.
- Not-found instrument pages answer HTTP 200 (the streamed loading state commits the status first); they are marked `noindex`.
- No Storybook, visual regression or Lighthouse budget yet (DESIGN_SYSTEM section 10); the e2e suite is not in CI.

## Dependency notes

- Next.js is pinned to 16.4.5 (N1, D-84): the lowest 16.x release fixing GHSA-mfr8-8qww-v76h and GHSA-vc7v-qv4w-wrv8. Older 16.2.0 to 16.4.4 builds stop with a SecurityFatalError advisory notice. This app uses none of the affected features (no `use cache`, `unstable_cache`, root params or Cache Components).
