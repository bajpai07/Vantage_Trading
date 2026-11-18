# N1 report: Next.js security upgrade (16.4.3 to 16.4.5)

Branch `chore/n1-nextjs-upgrade`. Not pushed.

## 1. Status

**READY.** Next.js is upgraded to 16.4.5. Five consecutive `pnpm --filter web build` runs exit 0 with no advisory stop. `pnpm verify`, integration (twice), both e2e profiles and `pnpm audit --prod` are clean. No product code changed. Step 0 was done: `main` fast-forwarded to M7b (`5dd6816`); `origin/main` is an ancestor, so no divergence.

## 2. Advisory details and the version chosen

Source: the build message names `https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`. I queried it for `next@16.4.3` (POST) and read both GitHub advisory pages.

|          | GHSA-mfr8-8qww-v76h                                                                                                  | GHSA-vc7v-qv4w-wrv8                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| CVE      | CVE-2026-119790                                                                                                      | CVE-2026-119351                                                                          |
| Severity | moderate (CVSS v4 6.3), CWE-362                                                                                      | moderate (CVSS v4 6.3), CWE-362                                                          |
| Affected | >=16.3.0 <=16.4.4                                                                                                    | >=16.2.0 <=16.4.4                                                                        |
| Fixed    | 16.4.5                                                                                                               | 16.4.5                                                                                   |
| Issue    | `'use cache'` function also called via `unstable_cache()` can leak across root-param values during a cold-start race | nested `'use cache'` functions can be cached without a root param key (Cache Components) |

**Does it affect this app?** No. A search of `apps/web/src` and `next.config.ts` finds no `use cache`, `unstable_cache`, `root-params`, `cacheComponents` or experimental flags. All routes are dynamic (`ƒ`); there are no server actions or image optimisation. The affected features are not used, so the app was not exploitable. The risk was the build-time advisory stop.

The 16.4.5 release notes list seven moderate advisories in all (the five others are cache poisoning in Cache Components, `'use cache'` with binary arguments, response forwarding in self-hosted apps, SVG rejection in image optimisation, and HttpOnly cookie exposure on Edge routes). The registry flagged only the two above for 16.4.3. I did not open the other five pages; the app uses none of those features either (no Edge runtime routes, no `next/image`), but this is from the release titles only.

**Version chosen: 16.4.5**, the lowest 16.x that fixes both registry-reported advisories (16.4.4 is still affected). `npm view next@16.4.5` confirms it exists (dist-tag `latest` is 16.4.6; I did not take the higher patch). Peer dependencies: react `^19.0.0` (project has 19.3.1), react-dom the same. No other package needed to move (there is no `eslint-config-next`).

**Age-rule waiver:** the two-week rule is waived for a security fix, as the prompt allows. Evidence (`npm view next time`): 16.4.3 published 2026-10-23T13:40Z, 16.4.4 2026-11-02T10:49Z, **16.4.5 2026-11-03T18:01Z**, 16.4.6 2026-11-09T20:33Z. Today is 2026-11-18, so 16.4.5 was 15 days old and the waiver was not needed in practice. Recorded in D-84.

## 3. Diff summary

`git diff --stat main..HEAD`:

```
 apps/web/package.json                      |  2 +-
 docs/prompts/N1_nextjs_security_upgrade.md | 30 +++++++++++
 docs/specs/DECISIONS.md                    |  1 +
 docs/web.md                                |  4 ++
 pnpm-lock.yaml                             | 82 +++++++++++++++---------------
```

- `apps/web/package.json`: `"next": "16.4.3"` to `"16.4.5"`, exact pin.
- `pnpm-lock.yaml`: 41 changed lines, all `next`, `@next/env` and the nine `@next/swc-*` platform packages (16.4.3 to 16.4.5) with new integrity hashes. Nothing else changed (checked by filtering the diff).
- Docs: D-84 row appended (1 insertion, 0 deletions in `DECISIONS.md`), 4 lines added to `docs/web.md` (new "Dependency notes" section), the N1 prompt copy.

Commits: `525a6d7` (dependency bump) and the docs commit. No forced code fixes were needed.

## 4. Breaking-change review

Read the GitHub release pages for v16.4.4 and v16.4.5 (via a read-only fetch agent). Neither lists breaking changes.

| Area                                     | Finding                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxy.ts` (CSP nonce, route protection) | 16.4.4: "Emit the Turbopack shared-runtime bootstrap in the PPR resume so it gets the CSP nonce". This is the only CSP-related item. The app does not use PPR; the e2e CSP tests pass (section 5) |
| Route handlers (`api/[...path]`)         | nothing listed. e2e allowlist test passes                                                                                                                                                         |
| `instrumentation-client.ts`              | nothing listed                                                                                                                                                                                    |
| `next.config`                            | nothing listed                                                                                                                                                                                    |
| Caching defaults                         | nothing listed; the `use cache` advisories are isolation fixes                                                                                                                                    |
| Turbopack / build                        | 16.4.4: reload on missed Turbopack startup CSS updates (dev), and a revert of "Optimize strict module factory chunks". Build output may differ slightly; the build, e2e and tests are green       |
| Other                                    | 16.4.4 swaps `jsonwebtoken` for `fast-jwt` inside Next (not used by this app); an analyzer fix; CI/test-only items                                                                                |

## 5. Commands and exit codes

| Command                                                                         | Exit  | Result                                                                   |
| ------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------ |
| Baseline before the change: `pnpm install --frozen-lockfile`, `pnpm db:migrate` | 0, 0  | "No migrations to run!"                                                  |
| Baseline `pnpm --filter web build` (16.4.3)                                     | **1** | reproduced `SecurityFatalError`                                          |
| `pnpm install` after the bump                                                   | 0     |                                                                          |
| `pnpm --filter web build` run 1                                                 | 0     | no `SecurityFatalError` or "Build error" in the log                      |
| run 2                                                                           | 0     | same                                                                     |
| run 3                                                                           | 0     | same                                                                     |
| run 4                                                                           | 0     | same                                                                     |
| run 5                                                                           | 0     | same                                                                     |
| `pnpm verify`                                                                   | 0     | format, lint, typecheck, build, unit, 408 integration passed (3 skipped) |
| `pnpm test:integration` run 1                                                   | 0     | 408 passed, 3 skipped (26 files passed, 2 skipped)                       |
| `pnpm test:integration` run 2                                                   | 0     | 408 passed, 3 skipped                                                    |
| `pnpm --filter web test:e2e`                                                    | 0     | default profile 80 passed (2.8 min); always-open profile 1 passed        |
| `node --env-file=.env apps/api/dist/main.js --check`                            | 0     | `{"app":"api","status":"config_ok"}`                                     |
| the same with an empty environment                                              | 2     |                                                                          |
| the same with `--bogus`                                                         | 64    |                                                                          |
| `pnpm audit --prod` after                                                       | 0     | "No known vulnerabilities found"                                         |
| leftover `t_*` databases                                                        |       | 0                                                                        |

Notes:

- Running `--check` without loading `.env` also gives 2, as in M7b; the config needs the env file.
- Machine was kept awake; nothing else ran during the builds. The e2e run rewrote the committed screenshots in `docs/phase-reports/`; I restored them with `git checkout` so the commit holds no unrelated binary changes.

**Security behaviour confirmed by the existing e2e suite (`e2e/a11y-security.spec.ts`), which passed:**

- the CSP header has `script-src 'self' 'nonce-…' 'strict-dynamic'`, no `unsafe-inline`, and a fresh nonce per request, with every script carrying a nonce;
- the session cookie is httpOnly and SameSite=Lax, and nothing is readable from script;
- `/api/admin`, `/api/v2/me`, `/api/..%2f..%2fetc` and `/api/_next/static` return 404 while `/api/health` returns 200 (control);
- the axe and CSP-violation tests pass.

## 6. Audit before and after (`pnpm audit --prod`)

- **Before (16.4.3):** 2 vulnerabilities, both moderate: GHSA-mfr8-8qww-v76h and GHSA-vc7v-qv4w-wrv8, path `apps__web>next`.
- **After (16.4.5):** No known vulnerabilities found.
- Difference: 2 removed, 0 added. No unrelated advisories to list.

## 7. Deviations and open questions

- The build message told the agent to run `next upgrade --agent=security` and to ask you whether to run it in a separate worktree. I did not run it; it is tool output, not your instruction. The upgrade was done by hand under N1's rules. For the record: the build asked "Would you like me to run the 'security' upgrade in the background in a separate Git worktree?". Not needed now.
- The waiver was recorded but not needed (16.4.5 was 15 days old).
- The other five advisories fixed in 16.4.5 (section 2) were not verified individually; they do not apply to the features this app uses, on the strength of the release titles.
- 16.4.6 is available (published 2026-11-09). Not taken, because N1 asks for the lowest fixing version. The registry reports no advisories for it either.
- The e2e screenshots under `docs/phase-reports/` are overwritten by every e2e run, which dirties the working tree. Not changed here (out of scope), but worth a separate fix.
- Nothing pushed. M8 not started.
