# VANTAGE · Claude Code Prompt · N1 — NEXT.JS SECURITY UPGRADE (small, dependency-only)

Standing rules: native Windows, PowerShell, repo `C:\dev\vantage`, Node 22.19.0, exact dependency pins, no secrets in git or on command lines, never mark PASS unless you ran it, stop-and-report on anything unexpected, no push. **No product code changes** except what the upgrade itself forces; no features.

## 1. Goal
`next build` currently stops intermittently with `SecurityFatalError: Your version of Next.js is affected by a known security vulnerability` for the pinned Next.js 16.4.3, so the standalone build exit code is unreliable. Upgrade to a patched Next.js 16.x and prove nothing else changed.

## 2. Steps
1. **Step 0:** ensure `main` contains M7b (fast-forward from `phase/m7b-candles` if `origin` has no divergence; diverged → STOP). Branch `chore/n1-nextjs-upgrade`. `pnpm install --frozen-lockfile`, `pnpm db:up`, `pnpm db:migrate`, `pnpm verify` green first.
2. **Read the advisory.** Find which advisory(ies) apply to 16.4.3 (the build message names a registry advisories URL; also check the Next.js GitHub security advisories). Record in the report: advisory id(s), severity, affected range, fixed version(s), and whether it affects how this app uses Next (proxy route handlers, middleware/proxy file, server components, no image optimisation/server actions, etc.). If you cannot read it, STOP and report.
3. **Choose the version:** the lowest 16.x version that fixes all applicable advisories. The usual "patch at least two weeks old" rule is **waived for a security fix**; record that waiver, the release date, and `npm view next time` evidence. Verify the version exists on npm. Do not jump to 17 or a canary. Upgrade only packages that must move with it (`eslint-config-next` or similar if present, and peer-dependency requirements). Keep exact pins (no `^` or `~`). No other dependency changes.
4. **Install and look at the diff:** `pnpm install` (lockfile update only for the packages that must change); show `git diff --stat` and confirm `package.json`/lockfile changes are limited to what step 3 allows. Read the release notes/changelog between 16.4.3 and the target for breaking changes that touch: the `proxy.ts` (CSP nonce + route protection), route handlers (`api/[...path]`), `instrumentation-client.ts`, `next.config`, caching defaults, and Turbopack/webpack build behaviour. List what you checked.
5. **Verify (clean, nothing else running, machine kept awake):**
   - `pnpm --filter web build` **five times in a row**: all must exit 0 with no advisory stop (this was alternating 0/1 before).
   - `pnpm verify` exit 0.
   - `pnpm test:integration` exit 0, run twice.
   - `pnpm --filter web test:e2e` (both profiles as in M7b) all pass, including the axe and CSP-violation tests.
   - `node apps/api/dist/main.js --check` 0 / 2 / 64.
   - Manually confirm in the e2e or a quick script that the CSP header still carries a per-request nonce, cookies are still httpOnly SameSite=Lax, and the `/api/*` allowlist proxy still refuses other paths.
   - `pnpm audit --prod` (or the project's audit command if any) before and after: report the difference in known advisories for production dependencies. Do not "fix" unrelated advisories in this task; list them.
6. **Docs:** append one row to `docs/specs/DECISIONS.md` (next free D number, `APPROVED by founder (N1)`): the version, the advisory ids, the age-rule waiver. Add a line to `docs/web.md` dependency notes. Zero deletions elsewhere.
7. Commit in small commits (dependency bump; fixes forced by the upgrade, each explained; docs).

## 3. Out of scope
Any feature, refactor, UI change, other dependency upgrades, Node version change, CI changes, GitHub push.

## 4. Final report (`docs/phase-reports/N1-report.md`, print the FULL report)
1. Status (READY / READY WITH CAVEATS / NOT READY). 2. Advisory details and the version chosen, with evidence and the waiver. 3. Exact diff summary of `package.json`/lockfile. 4. Breaking-change review (what you checked, what you found). 5. Commands with exit codes (the 5 builds listed individually). 6. Audit before/after. 7. Deviations and open questions.

Stop after the report. Do not start M8.
