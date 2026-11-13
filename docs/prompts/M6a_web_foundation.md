# VANTAGE · Claude Code Prompt · M6a — WEB APP FOUNDATION, AUTH AND PORTFOLIO SCREENS

Same standing rules as M0–M5: native Windows, PowerShell, repo `C:\dev\vantage`, Node 22.19.0, exact dependency versions (verify each exists on npm before pinning), LF endings, no secrets in git or on command lines, specs are the source of truth, stop-and-report on ambiguity, never mark PASS unless you ran it, no push.

## 1. Goal
First user-facing screens, **read-mostly**: a Next.js web app in `apps/web` that lets a user register, log in, log out, and see their portfolio, orders/executions history and account activity. **No trade ticket, no instrument search (M6b), no charts beyond a simple equity line if trivial, no real provider.**

Product-honesty rules (non-negotiable):
- All money/qty/price values come from the API as strings and are displayed **as received** (2-dp string; `exact` shown on hover/detail). The browser never parses money into JS numbers or does money arithmetic. Formatting adds thousands separators and signs by string manipulation only (or `@vantage/money` if it runs in the browser safely).
- Every valuation shows its freshness badge (REAL_TIME / DELAYED / STALE / CLOSED / UNAVAILABLE) and quote as-of time. UNAVAILABLE positions are visibly flagged and the totals show an "incomplete" notice; `totalReturn: null` renders as "—", never 0.
- While market data source is `FIXTURE`, a **persistent, non-dismissible banner** reads: "Simulated market data — not real prices". Source comes from the API, not a hard-coded flag. Staging/production must never run with FIXTURE (existing startup guard); the UI must still handle it honestly.
- This is a virtual-money simulator: show "Virtual money — not real trading" in the footer/account area.

Read first: `docs/specs/DESIGN_SYSTEM.md` (tokens, components, tone), PRD (screens, copy), ARCHITECTURE (web ↔ API, auth/cookies/CSRF), `docs/api.md` (all endpoints, error format), `docs/portfolio.md`, `docs/phase-reports/M5-report.md`. If specs conflict with this prompt, stop and report.

## 2. Step 0
Ensure `main` contains M5 (if `origin` exists, fetch; diverged → STOP). Branch `phase/m6a-web`. `pnpm install --frozen-lockfile`, `pnpm db:up`, `pnpm db:migrate`, `pnpm verify` green before changes (stale DB: `pnpm db:reset`).

## 3. Decisions (record as D-64… `APPROVED by founder (M6a)` unless you object with a reason)
- **D-64** Next.js (App Router) + TypeScript strict + the design tokens from DESIGN_SYSTEM. Keep dependencies minimal: no UI mega-framework; styling per the spec (CSS variables/tokens; Tailwind only if DESIGN_SYSTEM says so). Dark theme first if the spec says so.
- **D-65** Browser talks to the API **same-origin** through a Next.js rewrite/proxy (`/api/*` → API), so the `vantage_session` cookie stays httpOnly, SameSite=Lax, and the existing Origin-header CSRF check keeps working. No tokens in localStorage/sessionStorage. No CORS opened on the API.
- **D-66** Route protection happens **server-side** (server components/middleware reading the session via the API), not by hiding UI. Unauthenticated → redirect to `/login`; authenticated users visiting `/login` → `/portfolio`.
- **D-67** Data fetching: server components for first paint; light client refresh (polling every 15 s, paused when the tab is hidden) for the portfolio only. No WebSockets yet.
- **D-68** Security headers from Next config: strict CSP (no inline scripts except Next's nonce mechanism), `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`. API error bodies are shown as friendly messages, never raw JSON, stack traces or request ids except a "support code" line.

## 4. Tasks (in order; verify each; commit after each)

**T1 · Scaffold `apps/web`.** Next.js app wired into pnpm/Turborepo (`dev`, `build`, `lint`, `typecheck`, `test`), config validated at startup (API base URL), no secrets in the repo. `pnpm verify` includes the web app. Design tokens + base layout (header, nav, footer with "virtual money" notice, the FIXTURE banner component).

**T2 · API client and auth.** Typed client built on `@vantage/contracts` Zod schemas (validate responses; on schema mismatch show a safe error, never render unvalidated data). Pages: `/register`, `/login`, logout action, session check. Forms: accessible labels, inline errors, disabled-while-submitting, password rules per M2, no password in URLs or logs. Handle 401 (session expired → login), 429 (rate limit → message with retry hint), network error, 5xx.

**T3 · Screens.**
- `/portfolio`: cash, equity, total return (or "—" with incomplete notice), realised P&L, fees, positions table (symbol, qty, avg cost, mark + basis, market value, unrealised P&L, freshness badge, as-of). Empty state for a new account (10,000 cash, no positions). Equity history line from `/v1/portfolio/history` (simple, accessible, hides gracefully if < 2 points).
- `/orders`: order list with status/reject reason in plain language (map every reject code to a human sentence; unknown code → generic message), cursor "load more".
- `/activity`: executions and ledger activity (the two M5 endpoints), cursor pagination.
- Loading, empty and error states for every screen. Responsive down to 375 px. Keyboard navigable, visible focus, colour is never the only signal (P&L has sign and arrow), `prefers-reduced-motion` respected.

**T4 · Tests.**
Unit (component/format): money display helpers are string-only (property test: output digits equal input digits, no float conversion; negative/zero/very large/8-dp strings), reject-code map is exhaustive against the contracts list, freshness badge mapping.
E2E (Playwright, real API + real Postgres + FIXTURE quotes, injected-clock/test mode as the API allows; document how to run on Windows incl. `playwright install`):
1. Register → lands on empty portfolio showing 10,000.00 cash and the FIXTURE banner.
2. Place a BUY through the API directly (M4b endpoint, test helper) → portfolio shows the position, correct strings (cash 8,099.60 for vector A), badge and as-of; poll refresh updates without reload.
3. UNAVAILABLE quote → flagged position, "incomplete" notice, total return "—".
4. Logout → protected pages redirect; back button does not show cached private data; expired/invalid session → login.
5. Another user's data never appears (two browser contexts).
6. Accessibility: automated axe check on each page (no serious/critical violations); keyboard-only login works.
7. Security: cookie flags (httpOnly, SameSite), no token in storage, CSP header present, no `console.error` noise.
- Done when: `pnpm verify` green; `pnpm test:integration` still green twice; e2e green locally (document that e2e is not yet in CI); no leftover `t_*` databases.

**T5 · Docs.** `docs/web.md` (structure, how to run dev/e2e, honesty rules, copy for each reject code), `docs/api.md` untouched except fixes, append D-64..D-68 to `docs/specs/DECISIONS.md` (zero deletions).

## 5. Out of scope
Trade ticket, instrument search/detail, watchlists (M6b+); candlestick/price charts; WebSocket; onboarding tour; email verification/password reset (M8); i18n; dark/light toggle unless spec requires; admin screens; real provider; CI/GitHub push.

## 6. Common mistakes
Parsing money with `Number`/`parseFloat`; computing totals in the browser; hard-coding the FIXTURE flag; storing tokens in localStorage; enabling CORS instead of a same-origin proxy; hiding routes only in the UI; rendering API data without schema validation; showing 0 or cost for unvalued positions; colour-only P&L; no empty/error states; adding a UI kit not in the spec; large unreviewed dependency additions.

## 7. Verification (clean clone of the branch)
```powershell
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate ; pnpm db:migrate ; pnpm db:status
pnpm verify
pnpm test:integration          # second consecutive run
pnpm --filter web build
pnpm --filter web test:e2e
node apps/api/dist/main.js --check
pnpm db:down
```

## 8. Acceptance criteria (PASS / FAIL / UNVERIFIED, each run)
1. Step 0 baseline green. 2. Web app builds and `pnpm verify` includes it. 3. Register/login/logout work end to end; protected routes enforced server-side. 4. Money is displayed from API strings only; property test proves no float conversion. 5. Freshness badges, UNAVAILABLE flag, incomplete notice and "—" total return proven in e2e. 6. FIXTURE banner driven by API data. 7. Cookie and CSP checks pass; no token in storage. 8. Isolation between two users proven. 9. axe: no serious/critical violations; keyboard login works; 375 px layout checked. 10. Loading/empty/error states exist for all screens. 11. Docs and D-64..D-68 appended, zero deletions. 12. All previous suites still green.

## 9. Final report (`docs/phase-reports/M6a-report.md`, print the FULL report in the reply)
1. Status: READY / READY WITH CAVEATS / NOT READY for M6b (≤ 5 lines). 2. Dependency list with exact versions and why each. 3. Task status T1–T5. 4. Files created/modified. 5. Commands with exit codes; failing output verbatim. 6. Acceptance table with evidence (screenshots saved under `docs/phase-reports/m6a/`, not committed if large). 7. Test list with controls. 8. Deviations, spec questions. 9. Known limitations and what M6b needs.

Do not start M6b. Stop after the report.
