// M10 T3 (D-115): the diagram document equals its Mermaid sources, and every decimal number in the two numeric diagrams (the limit BUY
// sequence, golden vector E, and the ledger example, golden vector A) appears as a hard-coded string in the code tests that own the vector.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');
const noCommas = (s: string): string => s.replaceAll(',', '');
const numbers = (s: string): string[] => [...new Set(noCommas(s).match(/\d+\.\d{2,}/g) ?? [])];

const sources = {
  '03-limit-buy-sequence': [
    'packages/engine/src/limit-orders.test.ts',
    'apps/api/src/modules/trading/limit-orders.int.test.ts',
    'apps/api/src/modules/orders/orders-limit-http.int.test.ts',
  ],
  '04-ledger-accounts': ['packages/engine/src/engine.test.ts'],
} as const;

describe('architecture diagrams', () => {
  const files = readdirSync(resolve(root, 'docs/diagrams')).filter((n) => n.endsWith('.mmd'));

  it('there are five diagrams, and ARCHITECTURE_DIAGRAMS.md contains each source verbatim', () => {
    expect(files).toHaveLength(5);
    const doc = read('docs/ARCHITECTURE_DIAGRAMS.md');
    for (const f of files) {
      expect(doc, f).toContain('```mermaid\n' + read(`docs/diagrams/${f}`).trimEnd() + '\n```');
    }
  });

  for (const [name, tests] of Object.entries(sources)) {
    it(`every decimal number in ${name} is a hard-coded golden-vector string in the code tests`, () => {
      const diagram = numbers(read(`docs/diagrams/${name}.mmd`));
      expect(diagram.length).toBeGreaterThanOrEqual(4);
      const haystack = tests.map((t) => noCommas(read(t))).join('\n');
      for (const n of diagram) expect(haystack, `${name}: ${n}`).toContain(n);
    });
  }

  it('control: a number that is not a golden string is detected', () => {
    const haystack = noCommas(read(sources['03-limit-buy-sequence'][0]));
    expect(haystack).toContain('224.97475');
    expect(haystack).not.toContain('224.97476');
  });
});
