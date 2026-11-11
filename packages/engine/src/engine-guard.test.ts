import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function errors(code: string, filePath: string) {
  const [res] = await eslint.lintText(code, { filePath });
  return (res?.messages ?? []).filter((m) => m.severity === 2);
}

const ENGINE = 'packages/engine/src/virtual.ts';

describe('engine determinism guard (ESLint)', () => {
  it.each([
    ['Date.now', 'export const a = Date.now();'],
    ['new Date()', 'export const a = new Date();'],
    ['Math.random', 'export const a = Math.random();'],
    ['performance.now', 'export const a = performance.now();'],
    ['parseFloat', 'export const a = parseFloat("1");'],
    ['Number()', 'export const a = Number("1");'],
    ['decimal literal', 'export const a = 0.5;'],
    ['exponent literal', 'export const a = 1e3;'],
    ['node:fs import', 'import { readFileSync } from "node:fs";\nexport const a = readFileSync;'],
    [
      'node:crypto import',
      'import { randomUUID } from "node:crypto";\nexport const a = randomUUID;',
    ],
    ['fs import', 'import fs from "fs";\nexport const a = fs;'],
    ['pg import', 'import pg from "pg";\nexport const a = pg;'],
    ['http import', 'import http from "http";\nexport const a = http;'],
  ])('bans %s', async (_name, code) => {
    expect((await errors(code, ENGINE)).length).toBeGreaterThan(0);
  });

  it('allows pure code: integers, hex, strings, new Date(arg), the money package', async () => {
    const code = [
      'import { parse } from "@vantage/money";',
      'export const a = parse("1.5");',
      'export const b = 0xE;',
      'export const c = 8;',
      'export const d = new Date(0);',
    ].join('\n');
    expect(await errors(code, ENGINE)).toEqual([]);
  });

  it('the real engine and money sources are clean', async () => {
    const results = await eslint.lintFiles([
      'packages/engine/src/index.ts',
      'packages/engine/src/errors.ts',
      'packages/engine/src/lots.ts',
      'packages/engine/src/market-order.ts',
      'packages/money/src/index.ts',
    ]);
    expect(results.flatMap((r) => r.messages)).toEqual([]);
  });
});
