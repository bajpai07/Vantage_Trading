// MARKET_DATA section 13 (criterion 8): no hard-coded price tables outside tests and the labelled fixture.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../../..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const PRICE_LITERAL = /\b(bid|ask|last|price|close)\s*:\s*['"]?[0-9]+\.[0-9]+/;

describe('no fabricated price tables in shipped code', () => {
  const files = [...walk(join(root, 'apps/api/src')), ...walk(join(root, 'packages'))].filter(
    (f) => {
      const rel = relative(root, f).replaceAll('\\', '/');
      return !rel.endsWith('.test.ts') && !rel.includes('/testing') && !rel.includes('/fixture/');
    },
  );

  it('scans a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('finds no bid/ask/last/price literals outside tests and apps/api/src/modules/market-data/fixture/', () => {
    const offenders = files.filter((f) => PRICE_LITERAL.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });

  it('the detector itself works (control)', () => {
    expect(PRICE_LITERAL.test("const q = { bid: '10.01' }")).toBe(true);
    expect(PRICE_LITERAL.test('const q = { bid: price }')).toBe(false);
  });
});
