// M10 T4 (D-115): FACTS.md lists every decision, keeps the UNVERIFIED items, and the documents carry no marketing language.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');

describe('docs/FACTS.md', () => {
  const facts = read('docs/FACTS.md');
  const ids = read('docs/specs/DECISIONS.md')
    .split('\n')
    .map((l) => /^\| (D-\d+)/.exec(l)?.[1])
    .filter((x): x is string => x !== undefined);

  it('indexes every decision of DECISIONS.md (control: the list is not empty and holds D-01 and D-116)', () => {
    expect(ids.length).toBeGreaterThan(100);
    expect(ids).toContain('D-01');
    expect(ids).toContain('D-116');
    for (const id of ids) expect(facts.includes(`| ${id} `), id).toBe(true);
  });

  it('keeps the UNVERIFIED items and the seven sections', () => {
    expect(facts.match(/UNVERIFIED/g)?.length).toBeGreaterThanOrEqual(3);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(facts).toContain(`\n## ${String(n)}. `);
  });
});

describe('no marketing language in the project documents', () => {
  const banned =
    /\b(powerful|blazing|seamless|robust|cutting-edge|world-class|best-in-class|revolutionary|state-of-the-art|enterprise-grade|production-ready|battle-tested|production-grade|real-time exchange|bank-level|game-chang\w+)\b/i;
  for (const f of [
    'README.md',
    'docs/FACTS.md',
    'docs/ARCHITECTURE_DIAGRAMS.md',
    'docs/DOCKER.md',
    'apps/web/src/app/about/page.tsx',
  ]) {
    it(f, () => expect(banned.exec(read(f))?.[0]).toBeUndefined());
  }
  it('control: the pattern does match', () =>
    expect(banned.test('a seamless experience')).toBe(true));
});
