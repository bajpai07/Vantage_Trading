import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function lint(code: string, filePath = 'packages/money/src/virtual.ts') {
  const [res] = await eslint.lintText(code, { filePath });
  return res?.messages ?? [];
}

const banned: Array<[string, string]> = [
  ['parseFloat', 'export const a = parseFloat("1");'],
  ['parseInt', 'export const a = parseInt("1", 10);'],
  ['Number()', 'export const a = Number("1");'],
  ['new Number()', 'export const a = new Number(1);'],
  ['Number.parseFloat', 'export const a = Number.parseFloat("1");'],
  ['Math.floor', 'export const a = Math.floor(1);'],
  ['Math.random', 'export const a = Math.random();'],
  ['decimal literal 1.5', 'export const a = 1.5;'],
  ['leading-dot literal .5', 'export const a = .5;'],
  ['trailing-dot literal 1.', 'export const a = 1.;'],
  ['exponent literal 1e3', 'export const a = 1e3;'],
  ['exponent literal 1E-3', 'export const a = 1E-3;'],
  ['Date.now', 'export const a = Date.now();'],
  ['new Date()', 'export const a = new Date();'],
  ['performance.now', 'export const a = performance.now();'],
];

describe('money guard lint rules', () => {
  it.each(banned)('bans %s', async (_name, code) => {
    const msgs = await lint(code);
    expect(msgs.filter((m) => m.severity === 2).length).toBeGreaterThan(0);
  });

  it('allows hex literals (0xE), plain integers, bigint, strings and new Date(arg)', async () => {
    const msgs = await lint(
      [
        'export const a = 0xE;',
        'export const b = 0xEE;',
        'export const c = 42;',
        'export const d = 10n;',
        'export const e = "1.5e3";',
        'export const f = new Date(0);',
      ].join('\n'),
    );
    expect(msgs).toEqual([]);
  });

  it('does not apply to test files or other packages', async () => {
    expect(await lint('export const a = 1.5;', 'packages/money/src/x.test.ts')).toEqual([]);
    expect(await lint('export const a = 1.5;', 'packages/config/src/x.ts')).toEqual([]);
  });
});
