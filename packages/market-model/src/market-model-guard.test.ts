import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function errors(code: string, filePath = 'packages/market-model/src/virtual.ts') {
  const [res] = await eslint.lintText(code, { filePath });
  return (res?.messages ?? []).filter((m) => m.severity === 2);
}

describe('market-model determinism guard (ESLint)', () => {
  it.each([
    ['Date.now', 'export const a = Date.now();'],
    ['new Date()', 'export const a = new Date();'],
    ['Date()', 'export const a = Date();'],
    ['performance.now', 'export const a = performance.now();'],
    ['Math.random', 'export const a = Math.random();'],
    ['Math.round (float math)', 'export const a = Math.round(2);'],
    ['Math.sqrt', 'export const a = Math.sqrt(4);'],
    ['parseFloat', 'export const a = parseFloat("1");'],
    ['Number()', 'export const a = Number("1");'],
    ['decimal literal', 'export const a = 0.5;'],
    ['exponent literal', 'export const a = 1e3;'],
    ['node:fs import', 'import { readFileSync } from "node:fs";\nexport const a = readFileSync;'],
    ['pg import', 'import pg from "pg";\nexport const a = pg;'],
  ])('bans %s', async (_n, code) => {
    expect((await errors(code)).length).toBeGreaterThan(0);
  });

  it('allows integer parsing, Math.floor/trunc/abs/min/max, new Date(arg), Date.UTC and Intl', async () => {
    const code = [
      'export const a = parseInt("42", 10);',
      'export const b = Math.floor(7) + Math.trunc(3) + Math.abs(2) + Math.min(1, 2) + Math.max(1, 2);',
      'export const c = new Date(0);',
      'export const d = Date.UTC(2026, 0, 1);',
      'export const e = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York" });',
    ].join('\n');
    expect(await errors(code)).toEqual([]);
  });

  it('does not apply to test files', async () => {
    expect(
      await errors('export const a = Date.now();', 'packages/market-model/src/x.test.ts'),
    ).toEqual([]);
  });

  it('the real market-model sources are clean', async () => {
    const results = await eslint.lintFiles([
      'packages/market-model/src/calendar.ts',
      'packages/market-model/src/freshness.ts',
      'packages/market-model/src/validate.ts',
      'packages/market-model/src/types.ts',
      'packages/market-model/src/index.ts',
    ]);
    expect(results.flatMap((r) => r.messages)).toEqual([]);
  });
});
