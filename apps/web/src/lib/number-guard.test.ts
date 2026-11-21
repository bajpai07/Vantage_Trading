// M9a (D-103): float / Number conversion of a price, quantity or money value happens ONLY in src/lib/chart-data.ts. A few older
// files use Math, Number or parseInt for TIME, GEOMETRY or CONFIGURATION (never an amount); they are listed in eslint.config.mjs
// with reasons. This test pins that list EXACTLY: a new file that uses them must fail lint, and a file that starts using them
// without being listed fails here.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const src = join(repoRoot, 'apps', 'web', 'src');

/** The pinned allow-list: files that use the banned number syntax for time, geometry or configuration only. */
export const NUMBER_ALLOW_LIST = [
  'apps/web/src/components/equity-line.tsx', // SVG geometry of the equity line (M6a)
  'apps/web/src/components/feed-banner.tsx', // minutes of a feed delay
  'apps/web/src/components/quote-panel.tsx', // minutes of a delay and ages
  'apps/web/src/lib/api-core.ts', // Retry-After seconds
  'apps/web/src/lib/chart.ts', // equity line scaling (M6a)
  'apps/web/src/lib/config.ts', // integer environment variables
  'apps/web/src/lib/errors.ts', // seconds in a retry message
  'apps/web/src/lib/market.ts', // seconds of an age
] as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const eslint = new ESLint({ cwd: repoRoot });
const NUMBER_RULE = /Math\.\*|Number\(|parseInt|parseFloat|decimal or exponent|unary \+/;

/** The banned-number errors of a piece of code AS IF it lived in a new, unlisted file. */
async function numberErrors(code: string): Promise<string[]> {
  const [r] = await eslint.lintText(code, {
    filePath: join(repoRoot, 'apps/web/src/lib/__probe__.tsx'),
  });
  return (r?.messages ?? [])
    .filter((m) => m.severity === 2 && NUMBER_RULE.test(m.message))
    .map((m) => m.message);
}

describe('number guard', () => {
  it.each([
    'export const a = Math.round(1);',
    'export const a = Number("1");',
    'export const a = parseInt("1", 10);',
    'export const a = parseFloat("1");',
    'export const a = 0.5;',
    'export const a = +"1";',
  ])('a NEW unlisted file using %s fails lint', async (code) => {
    expect((await numberErrors(code)).length).toBeGreaterThan(0);
  });

  it('control: plain integers and string operations are fine in a new file', async () => {
    expect(
      await numberErrors('export const a = 3 + 4; export const b = "1.5".split(".");'),
    ).toEqual([]);
  });

  it('the files that use the banned syntax are EXACTLY the pinned allow-list plus chart-data.ts', async () => {
    const users: string[] = [];
    for (const f of sourceFiles(src)) {
      const rel = relative(repoRoot, f).replaceAll('\\', '/');
      if ((await numberErrors(readFileSync(f, 'utf8'))).length > 0) users.push(rel);
    }
    expect(users.sort()).toEqual(['apps/web/src/lib/chart-data.ts', ...NUMBER_ALLOW_LIST].sort());
  });

  it('the real lint config lets the allow-listed files and chart-data.ts use them, and nothing else', async () => {
    const lintReal = async (rel: string) => {
      const [r] = await eslint.lintText(readFileSync(join(repoRoot, rel), 'utf8'), {
        filePath: join(repoRoot, rel),
      });
      return (r?.messages ?? []).filter((m) => m.severity === 2 && NUMBER_RULE.test(m.message));
    };
    for (const rel of [...NUMBER_ALLOW_LIST, 'apps/web/src/lib/chart-data.ts'])
      expect(await lintReal(rel), rel).toEqual([]);
  });
});
