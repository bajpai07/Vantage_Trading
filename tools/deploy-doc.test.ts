// M10 T5 (D-115): docs/DEPLOY.md lists every environment variable read by the validated API config and the web config, and keeps the
// hosting table dated.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');
const names = (src: string): string[] => [
  ...new Set([...src.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1] as string)),
];

describe('docs/DEPLOY.md', () => {
  const doc = read('docs/DEPLOY.md');
  const api = names(read('packages/config/src/index.ts'));
  const web = names(read('apps/web/src/lib/config.ts'));

  it('finds the variables it is supposed to check (control)', () => {
    expect(api).toContain('TRUSTED_PROXY_CIDRS');
    expect(api).toContain('DATABASE_URL');
    expect(web).toContain('DEMO_ACCOUNTS');
    expect(api.length).toBeGreaterThan(20);
  });

  it('has a table row for every API and web variable, and for the infrastructure variables', () => {
    const extra = [
      'DATABASE_MIGRATOR_URL',
      'POSTGRES_SUPERUSER_PASSWORD',
      'VANTAGE_MIGRATOR_PASSWORD',
      'VANTAGE_APP_PASSWORD',
      'WEB_PORT',
    ];
    for (const n of [...api, ...web, ...extra]) expect(doc, n).toContain(`| \`${n}\``);
  });

  it('is dated and keeps its uncertainties', () => {
    expect(doc).toContain('2026-11-22');
    expect(doc.match(/UNVERIFIED/g)?.length).toBeGreaterThanOrEqual(5);
    expect(doc).toContain('### What I could not verify');
  });
});
